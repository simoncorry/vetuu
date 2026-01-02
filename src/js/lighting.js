/**
 * VETUU — WebGL Lighting System
 * 
 * GPU-accelerated dynamic lighting with:
 * - Point lights with smooth falloff
 * - Ambient day/night cycle
 * - Color temperature shifts
 * - Performant batched rendering
 */

// ============================================
// CONSTANTS
// ============================================
const MAX_LIGHTS = 64;  // Maximum simultaneous point lights
const LIGHT_TEXTURE_SCALE = 0.5;  // Render at half resolution for performance

// Day/night cycle colors
const AMBIENT_COLORS = {
  midnight: { r: 0.08, g: 0.10, b: 0.18, a: 0.85 },
  dawn:     { r: 0.45, g: 0.35, b: 0.25, a: 0.40 },
  morning:  { r: 0.95, g: 0.90, b: 0.80, a: 0.05 },
  noon:     { r: 1.00, g: 1.00, b: 0.95, a: 0.00 },
  evening:  { r: 0.90, g: 0.70, b: 0.50, a: 0.15 },
  dusk:     { r: 0.50, g: 0.30, b: 0.35, a: 0.50 },
  night:    { r: 0.10, g: 0.12, b: 0.22, a: 0.75 }
};

// ============================================
// SHADERS
// ============================================
const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;
  
  void main() {
    v_texCoord = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  
  varying vec2 v_texCoord;
  
  uniform vec2 u_resolution;
  uniform vec4 u_ambientColor;
  uniform float u_tileSize;
  uniform vec2 u_cameraOffset;
  
  // Light data: x, y, radius, intensity (packed as vec4)
  uniform vec4 u_lights[${MAX_LIGHTS}];
  uniform vec3 u_lightColors[${MAX_LIGHTS}];
  uniform int u_lightCount;
  
  // Smooth falloff function for natural light decay
  float lightFalloff(float dist, float radius) {
    float normalized = dist / radius;
    if (normalized >= 1.0) return 0.0;
    // Quadratic falloff with soft edge
    float falloff = 1.0 - normalized * normalized;
    return falloff * falloff;
  }
  
  void main() {
    // Convert to world pixel coordinates
    vec2 pixelCoord = v_texCoord * u_resolution + u_cameraOffset;
    
    // Start with ambient darkness
    vec3 finalColor = u_ambientColor.rgb;
    float darkness = u_ambientColor.a;
    
    // Accumulate light contributions
    float totalLight = 0.0;
    vec3 lightColorSum = vec3(0.0);
    
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= u_lightCount) break;
      
      vec4 light = u_lights[i];
      vec2 lightPos = light.xy * u_tileSize;
      float radius = light.z * u_tileSize;
      float intensity = light.w;
      
      float dist = distance(pixelCoord, lightPos);
      float contribution = lightFalloff(dist, radius) * intensity;
      
      if (contribution > 0.0) {
        totalLight += contribution;
        lightColorSum += u_lightColors[i] * contribution;
      }
    }
    
    // Blend lights with ambient
    if (totalLight > 0.0) {
      vec3 avgLightColor = lightColorSum / totalLight;
      // Reduce darkness based on light intensity
      darkness = darkness * (1.0 - min(totalLight, 1.0));
      // Tint with light color
      finalColor = mix(finalColor, avgLightColor, min(totalLight * 0.5, 0.8));
    }
    
    // Output: multiply blend mode effect
    // RGB = tint color, A = darkness amount
    gl_FragColor = vec4(finalColor, darkness);
  }
`;

// ============================================
// STATE
// ============================================
let canvas = null;
let gl = null;
let program = null;
let uniforms = {};
let positionBuffer = null;
let initialized = false;

let lights = [];  // Dynamic light sources
let staticLights = [];  // Lamp posts etc (cached)

let tileSize = 16;
let cameraX = 0;
let cameraY = 0;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the WebGL lighting system
 * @param {HTMLElement} container - Container element to append canvas to
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @param {number} tileSz - Tile size in pixels
 */
export function initLighting(container, width, height, tileSz) {
  tileSize = tileSz;
  
  // Create canvas
  canvas = document.createElement('canvas');
  canvas.id = 'lighting-canvas';
  canvas.width = Math.floor(width * LIGHT_TEXTURE_SCALE);
  canvas.height = Math.floor(height * LIGHT_TEXTURE_SCALE);
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${width}px;
    height: ${height}px;
    pointer-events: none;
    mix-blend-mode: multiply;
    z-index: 5;
    image-rendering: pixelated;
  `;
  
  container.appendChild(canvas);
  
  // Get WebGL context
  gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false
  });
  
  if (!gl) {
    console.error('[Lighting] WebGL not supported, falling back to CSS');
    return false;
  }
  
  // Compile shaders
  const vertexShader = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  
  if (!vertexShader || !fragmentShader) {
    console.error('[Lighting] Shader compilation failed');
    return false;
  }
  
  // Create program
  program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[Lighting] Program link failed:', gl.getProgramInfoLog(program));
    return false;
  }
  
  // Get uniform locations
  gl.useProgram(program);
  uniforms = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    ambientColor: gl.getUniformLocation(program, 'u_ambientColor'),
    tileSize: gl.getUniformLocation(program, 'u_tileSize'),
    cameraOffset: gl.getUniformLocation(program, 'u_cameraOffset'),
    lights: gl.getUniformLocation(program, 'u_lights'),
    lightColors: gl.getUniformLocation(program, 'u_lightColors'),
    lightCount: gl.getUniformLocation(program, 'u_lightCount')
  };
  
  // Create fullscreen quad
  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]), gl.STATIC_DRAW);
  
  const positionLoc = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
  
  // Enable blending
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  
  initialized = true;
  console.log('[Lighting] WebGL initialized successfully');
  return true;
}

/**
 * Compile a shader
 */
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[Lighting] Shader error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  
  return shader;
}

// ============================================
// LIGHT MANAGEMENT
// ============================================

/**
 * Set static lights (lamp posts, etc.) - called once on map load
 * @param {Array} lightObjects - Array of objects with light property
 */
export function setStaticLights(lightObjects) {
  staticLights = lightObjects
    .filter(obj => obj.light)
    .map(obj => ({
      x: obj.x + 0.5,  // Center of tile
      y: obj.y + 0.5,
      radius: obj.light.radius || 5,
      intensity: obj.light.intensity || 0.6,
      color: parseColor(obj.light.color || '#FFE4B5')
    }));
  
  console.log(`[Lighting] Registered ${staticLights.length} static lights`);
}

/**
 * Add a dynamic light (player torch, explosions, etc.)
 * @returns {number} Light ID for removal
 */
export function addDynamicLight(x, y, radius, intensity, color) {
  const light = {
    id: Date.now() + Math.random(),
    x: x + 0.5,
    y: y + 0.5,
    radius,
    intensity,
    color: parseColor(color)
  };
  lights.push(light);
  return light.id;
}

/**
 * Update a dynamic light position
 */
export function updateDynamicLight(id, x, y) {
  const light = lights.find(l => l.id === id);
  if (light) {
    light.x = x + 0.5;
    light.y = y + 0.5;
  }
}

/**
 * Remove a dynamic light
 */
export function removeDynamicLight(id) {
  lights = lights.filter(l => l.id !== id);
}

/**
 * Clear all dynamic lights
 */
export function clearDynamicLights() {
  lights = [];
}

/**
 * Parse color string to RGB object
 */
function parseColor(color) {
  if (typeof color === 'object') return color;
  
  // Handle hex colors
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return { r, g, b };
  }
  
  // Default warm lamp color
  return { r: 1.0, g: 0.9, b: 0.7 };
}

// ============================================
// RENDERING
// ============================================

/**
 * Update camera position for lighting calculations
 */
export function updateLightingCamera(x, y) {
  cameraX = x;
  cameraY = y;
}

/**
 * Render the lighting layer
 * @param {number} timeOfDay - 0-1 (0=midnight, 0.5=noon)
 */
export function renderLighting(timeOfDay = 0.5) {
  if (!initialized || !gl) return;
  
  // Calculate ambient color based on time of day
  const ambient = getAmbientForTime(timeOfDay);
  
  // Combine all lights
  const allLights = [...staticLights, ...lights];
  const visibleLights = cullLights(allLights);
  
  // Prepare light data arrays
  const lightData = new Float32Array(MAX_LIGHTS * 4);
  const colorData = new Float32Array(MAX_LIGHTS * 3);
  
  const count = Math.min(visibleLights.length, MAX_LIGHTS);
  for (let i = 0; i < count; i++) {
    const light = visibleLights[i];
    lightData[i * 4 + 0] = light.x;
    lightData[i * 4 + 1] = light.y;
    lightData[i * 4 + 2] = light.radius;
    lightData[i * 4 + 3] = light.intensity;
    
    colorData[i * 3 + 0] = light.color.r;
    colorData[i * 3 + 1] = light.color.g;
    colorData[i * 3 + 2] = light.color.b;
  }
  
  // Set uniforms
  gl.useProgram(program);
  gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
  gl.uniform4f(uniforms.ambientColor, ambient.r, ambient.g, ambient.b, ambient.a);
  gl.uniform1f(uniforms.tileSize, tileSize * LIGHT_TEXTURE_SCALE);
  gl.uniform2f(uniforms.cameraOffset, cameraX * LIGHT_TEXTURE_SCALE, cameraY * LIGHT_TEXTURE_SCALE);
  gl.uniform4fv(uniforms.lights, lightData);
  gl.uniform3fv(uniforms.lightColors, colorData);
  gl.uniform1i(uniforms.lightCount, count);
  
  // Clear and draw
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/**
 * Cull lights outside viewport for performance
 */
function cullLights(allLights) {
  const viewWidth = canvas.width / LIGHT_TEXTURE_SCALE / tileSize;
  const viewHeight = canvas.height / LIGHT_TEXTURE_SCALE / tileSize;
  const viewX = cameraX / tileSize;
  const viewY = cameraY / tileSize;
  
  const margin = 10;  // Extra tiles for light radius spillover
  
  return allLights.filter(light => {
    return light.x >= viewX - margin &&
           light.x <= viewX + viewWidth + margin &&
           light.y >= viewY - margin &&
           light.y <= viewY + viewHeight + margin;
  });
}

/**
 * Get ambient color for time of day
 */
function getAmbientForTime(t) {
  // t: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk
  
  const phases = [
    { t: 0.00, color: AMBIENT_COLORS.midnight },
    { t: 0.20, color: AMBIENT_COLORS.dawn },
    { t: 0.30, color: AMBIENT_COLORS.morning },
    { t: 0.50, color: AMBIENT_COLORS.noon },
    { t: 0.70, color: AMBIENT_COLORS.evening },
    { t: 0.80, color: AMBIENT_COLORS.dusk },
    { t: 0.90, color: AMBIENT_COLORS.night },
    { t: 1.00, color: AMBIENT_COLORS.midnight }
  ];
  
  // Find surrounding phases
  let prev = phases[phases.length - 1];
  let next = phases[0];
  
  for (let i = 0; i < phases.length - 1; i++) {
    if (t >= phases[i].t && t < phases[i + 1].t) {
      prev = phases[i];
      next = phases[i + 1];
      break;
    }
  }
  
  // Interpolate
  const range = next.t - prev.t;
  const progress = range > 0 ? (t - prev.t) / range : 0;
  
  // Smooth interpolation
  const smooth = progress * progress * (3 - 2 * progress);
  
  return {
    r: prev.color.r + (next.color.r - prev.color.r) * smooth,
    g: prev.color.g + (next.color.g - prev.color.g) * smooth,
    b: prev.color.b + (next.color.b - prev.color.b) * smooth,
    a: prev.color.a + (next.color.a - prev.color.a) * smooth
  };
}

// ============================================
// CLEANUP
// ============================================

export function destroyLighting() {
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  if (gl) {
    gl.deleteProgram(program);
    gl.deleteBuffer(positionBuffer);
  }
  canvas = null;
  gl = null;
  initialized = false;
}

// ============================================
// DEBUG
// ============================================
if (typeof window !== 'undefined') {
  window.VETUU_LIGHTING_DEBUG = () => ({
    initialized,
    staticLights: staticLights.length,
    dynamicLights: lights.length,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null
  });
  
  window.VETUU_SET_TIME = (t) => {
    if (t >= 0 && t <= 1) {
      renderLighting(t);
      return `Set time to ${t} (${t < 0.25 ? 'night' : t < 0.5 ? 'morning' : t < 0.75 ? 'afternoon' : 'evening'})`;
    }
    return 'Time must be 0-1 (0=midnight, 0.5=noon)';
  };
}

