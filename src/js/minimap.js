/**
 * VETUU — Minimap Module
 * Player-centered minimap with proper viewport, zoom, and responsiveness
 * 
 * Features:
 * - Player always centered
 * - Zoom in/out with scroll wheel (shows more/less of the world)
 * - Responsive to container size changes
 * - Click-to-move navigation
 * - Fog of war support
 * - NPC/enemy markers
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // How many world tiles to show at default zoom (radius from player)
  defaultViewRadius: 25,
  minViewRadius: 10,    // Zoomed in max (fewer tiles visible)
  maxViewRadius: 60,    // Zoomed out max (more tiles visible)
  zoomStep: 3,          // Tiles to add/remove per scroll
  
  // Colors - matching game actor colors
  playerColor: '#00E5E5',      // Cyan for minimap visibility
  playerGlow: 'rgba(0, 229, 229, 0.4)',
  playerStroke: 'rgba(255, 255, 255, 0.7)',
  pathColor: '#00E5E5',        // Cyan to match player
  pathStroke: 'rgba(255, 255, 255, 0.5)',
  npcColor: '#4CAF50',         // Green (friendly NPCs)
  npcGuardColor: '#69d2d6',    // Cyan (guards)
  npcMedicColor: '#E91E63',    // Pink (medics)
  enemyPassiveColor: '#DAA520', // Yellow/gold (passive - hue-rotate 60deg)
  enemyEngagedColor: '#e74c3c', // Red (hostile/engaged - hue-rotate -30deg)
  enemyAlphaColor: '#FFD700',   // Gold (alpha enemies - hue-rotate 40deg)
  fogColor: 'rgba(13, 15, 17, 0.92)',
  
  // Sizes (in canvas pixels)
  playerSize: 5,
  entitySize: 4,
  pathMarkerSize: 2,  // Smaller than player for hierarchy
  
  
  // Performance
  renderThrottle: 16, // ~60fps for smooth camera
};

// ============================================
// STATE
// ============================================
let canvas = null;
let ctx = null;
let fogCanvas = null;
let fogCtx = null;
let container = null;

let viewRadius = CONFIG.defaultViewRadius;
let renderScheduled = false;
let resizeObserver = null;
let animationFrameId = null;

// Camera position (smoothly interpolated toward player)
let cameraX = 0;
let cameraY = 0;
let lastFrameTime = 0;

// Smoothing - pixels per second approach for frame-rate independence
const CAMERA_SPEED = 8; // tiles per second base speed

// Cached references
let gameState = null;
let terrainImageData = null;

// ============================================
// INITIALIZATION
// ============================================
export function initMinimap(state) {
  gameState = state;
  
  container = document.getElementById('minimap');
  if (!container) {
    console.warn('[Minimap] Container #minimap not found');
    return;
  }
  
  // Create main canvas
  canvas = document.getElementById('minimap-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'minimap-canvas';
    container.appendChild(canvas);
  }
  ctx = canvas.getContext('2d', { alpha: false });
  
  // Create fog canvas (overlay)
  fogCanvas = document.getElementById('minimap-fog');
  if (!fogCanvas) {
    fogCanvas = document.createElement('canvas');
    fogCanvas.id = 'minimap-fog';
    container.appendChild(fogCanvas);
  }
  fogCtx = fogCanvas.getContext('2d');
  
  // Remove old player marker element (we'll draw it on canvas)
  const oldPlayerMarker = document.getElementById('minimap-player');
  if (oldPlayerMarker) {
    oldPlayerMarker.style.display = 'none';
  }
  
  // Set up responsive canvas sizing
  setupResponsiveCanvas();
  
  // Set up event listeners
  setupEventListeners();
  
  // Pre-render terrain to an offscreen buffer for performance
  prerenderTerrain();
  
  // Initialize camera and player dot positions
  if (gameState?.player) {
    cameraX = gameState.player.x;
    cameraY = gameState.player.y;
  }
  
  // Start render loop
  startRenderLoop();
  
  console.log('[Minimap] Initialized with view radius:', viewRadius);
}

// ============================================
// RENDER LOOP (for smooth camera)
// ============================================
function startRenderLoop() {
  if (animationFrameId) return;
  
  function loop(timestamp) {
    updateCamera(timestamp);
    render();
    animationFrameId = requestAnimationFrame(loop);
  }
  
  animationFrameId = requestAnimationFrame(loop);
}

// eslint-disable-next-line no-unused-vars -- exported for cleanup
function stopRenderLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function updateCamera(timestamp) {
  if (!gameState?.player) return;
  
  // Calculate delta time for frame-rate independent movement
  const deltaTime = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0.016;
  lastFrameTime = timestamp;
  
  const targetX = gameState.player.x;
  const targetY = gameState.player.y;
  
  // Calculate distance to target
  const dx = targetX - cameraX;
  const dy = targetY - cameraY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist < 0.001) {
    // Snap when very close
    cameraX = targetX;
    cameraY = targetY;
  } else {
    // Smooth exponential decay with frame-rate independence
    // Using 1 - e^(-speed * dt) for smooth asymptotic approach
    const smoothing = 1 - Math.exp(-CAMERA_SPEED * deltaTime);
    cameraX += dx * smoothing;
    cameraY += dy * smoothing;
  }
}

// ============================================
// RESPONSIVE CANVAS
// ============================================
function setupResponsiveCanvas() {
  // Use ResizeObserver for container size changes
  resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      resizeCanvas(width, height);
    }
  });
  
  resizeObserver.observe(container);
  
  // Initial size
  const rect = container.getBoundingClientRect();
  resizeCanvas(rect.width, rect.height);
}

function resizeCanvas(width, height) {
  // Account for any padding/borders
  const w = Math.floor(width);
  const h = Math.floor(height);
  
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    
    fogCanvas.width = w;
    fogCanvas.height = h;
    fogCanvas.style.width = `${w}px`;
    fogCanvas.style.height = `${h}px`;
    
    // Re-render after resize
    scheduleRender();
  }
}

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
  // Zoom with scroll wheel
  container.addEventListener('wheel', onWheel, { passive: false });
  
  // Click to move
  container.addEventListener('click', onClick);
  
  // Touch zoom (pinch)
  let lastTouchDist = null;
  
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lastTouchDist = getTouchDistance(e.touches);
    }
  }, { passive: true });
  
  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && lastTouchDist !== null) {
      e.preventDefault();
      const dist = getTouchDistance(e.touches);
      const scale = dist / lastTouchDist;
      
      // Zoom in = smaller view radius (see less, bigger tiles)
      // Zoom out = larger view radius (see more, smaller tiles)
      if (scale > 1.05) {
        zoomIn();
        lastTouchDist = dist;
      } else if (scale < 0.95) {
        zoomOut();
        lastTouchDist = dist;
      }
    }
  }, { passive: false });
  
  container.addEventListener('touchend', () => {
    lastTouchDist = null;
  }, { passive: true });
}

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function onWheel(e) {
  e.preventDefault();
  
  if (e.deltaY > 0) {
    zoomOut();
  } else {
    zoomIn();
  }
}

function onClick(e) {
  if (!gameState) return;
  
  // Don't process clicks on child elements like corpse marker
  if (e.target !== canvas && e.target !== container) return;
  
  const rect = container.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  
  // Convert click position to world coordinates
  const worldCoords = screenToWorld(clickX, clickY);
  if (!worldCoords) return;
  
  const { x, y } = worldCoords;
  
  // Check bounds
  if (x < 0 || y < 0 || x >= gameState.map.meta.width || y >= gameState.map.meta.height) {
    return;
  }
  
  // Import and call createPathTo
  import('./movement.js').then(({ createPathTo }) => {
    createPathTo(x, y, false);
  });
}

// ============================================
// ZOOM CONTROLS
// ============================================
function zoomIn() {
  viewRadius = Math.max(CONFIG.minViewRadius, viewRadius - CONFIG.zoomStep);
  scheduleRender();
}

function zoomOut() {
  viewRadius = Math.min(CONFIG.maxViewRadius, viewRadius + CONFIG.zoomStep);
  scheduleRender();
}

export function setZoom(radius) {
  viewRadius = Math.max(CONFIG.minViewRadius, Math.min(CONFIG.maxViewRadius, radius));
  scheduleRender();
}

export function getZoom() {
  return viewRadius;
}

export function resetZoom() {
  viewRadius = CONFIG.defaultViewRadius;
  scheduleRender();
}

// ============================================
// COORDINATE CONVERSION
// ============================================
function getViewport() {
  if (!gameState || !canvas) return null;
  
  const canvasW = canvas.width;
  const canvasH = canvas.height;
  
  // Calculate pixels per tile based on view radius and canvas size
  // We want viewRadius*2 tiles to fit in the smaller dimension
  const tilesVisible = viewRadius * 2;
  const pixelsPerTile = Math.min(canvasW, canvasH) / tilesVisible;
  
  // Calculate world bounds visible in the viewport
  const tilesX = canvasW / pixelsPerTile;
  const tilesY = canvasH / pixelsPerTile;
  
  // Use interpolated camera position for smooth movement
  return {
    // Center on camera (smoothly interpolated)
    centerX: cameraX,
    centerY: cameraY,
    // World tile bounds
    left: cameraX - tilesX / 2,
    top: cameraY - tilesY / 2,
    right: cameraX + tilesX / 2,
    bottom: cameraY + tilesY / 2,
    // Dimensions
    tilesX,
    tilesY,
    pixelsPerTile,
    canvasW,
    canvasH
  };
}

function worldToScreen(worldX, worldY) {
  const vp = getViewport();
  if (!vp) return null;
  
  const screenX = (worldX - vp.left) * vp.pixelsPerTile;
  const screenY = (worldY - vp.top) * vp.pixelsPerTile;
  
  return { x: screenX, y: screenY };
}

function screenToWorld(screenX, screenY) {
  const vp = getViewport();
  if (!vp) return null;
  
  const worldX = Math.floor(vp.left + screenX / vp.pixelsPerTile);
  const worldY = Math.floor(vp.top + screenY / vp.pixelsPerTile);
  
  return { x: worldX, y: worldY };
}

// ============================================
// PRE-RENDER TERRAIN
// ============================================
function prerenderTerrain() {
  if (!gameState) return;
  
  const { ground, legend, meta } = gameState.map;
  const width = meta.width;
  const height = meta.height;
  
  // Create offscreen canvas for terrain
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  
  // Draw each tile as a single pixel
  const imageData = offCtx.createImageData(width, height);
  const data = imageData.data;
  
  for (let y = 0; y < height; y++) {
    const row = ground[y];
    if (!row) continue;
    
    for (let x = 0; x < row.length; x++) {
      const tileChar = row[x];
      const tile = legend.tiles[tileChar];
      
      if (tile) {
        const color = parseColor(tile.color);
        const idx = (y * width + x) * 4;
        data[idx] = color.r;
        data[idx + 1] = color.g;
        data[idx + 2] = color.b;
        data[idx + 3] = 255;
      }
    }
  }
  
  offCtx.putImageData(imageData, 0, 0);
  terrainImageData = offscreen;
  
  console.log('[Minimap] Terrain pre-rendered:', width, 'x', height);
}

function parseColor(colorStr) {
  // Handle hex colors
  if (colorStr.startsWith('#')) {
    const hex = colorStr.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16)
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  
  // Handle rgb/rgba
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return {
      r: parseInt(match[1]),
      g: parseInt(match[2]),
      b: parseInt(match[3])
    };
  }
  
  // Default gray
  return { r: 128, g: 128, b: 128 };
}

// ============================================
// RENDERING
// ============================================
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!ctx || !gameState || !canvas.width || !canvas.height) return;
  
  const vp = getViewport();
  if (!vp) return;
  
  // Clear canvas
  ctx.fillStyle = '#0d0f11';
  ctx.fillRect(0, 0, vp.canvasW, vp.canvasH);
  
  // Draw terrain
  renderTerrain(vp);
  
  // Draw fog of war
  renderFog(vp);
  
  // Draw regions/POIs
  renderRegions(vp);
  
  // Draw entities
  renderEntities(vp);
  
  // Draw path markers (between entities and player)
  renderPath(vp);
  
  // Draw player (always on top, always centered)
  renderPlayer(vp);
}

function renderTerrain(vp) {
  if (!terrainImageData) return;
  
  const { left, top, tilesX, tilesY, pixelsPerTile } = vp;
  
  // Calculate source rectangle (in terrain image pixels = tiles)
  const srcX = Math.max(0, Math.floor(left));
  const srcY = Math.max(0, Math.floor(top));
  const srcW = Math.min(terrainImageData.width - srcX, Math.ceil(tilesX) + 1);
  const srcH = Math.min(terrainImageData.height - srcY, Math.ceil(tilesY) + 1);
  
  if (srcW <= 0 || srcH <= 0) return;
  
  // Calculate destination rectangle
  const dstX = (srcX - left) * pixelsPerTile;
  const dstY = (srcY - top) * pixelsPerTile;
  const dstW = srcW * pixelsPerTile;
  const dstH = srcH * pixelsPerTile;
  
  // Disable image smoothing for crisp pixels
  ctx.imageSmoothingEnabled = false;
  
  // Draw the visible portion of terrain, scaled up
  ctx.drawImage(
    terrainImageData,
    srcX, srcY, srcW, srcH,
    dstX, dstY, dstW, dstH
  );
}

function renderFog(vp) {
  if (!gameState.runtime.revealedTiles) return;
  
  const revealed = gameState.runtime.revealedTiles;
  const { left, top, right, bottom, pixelsPerTile, canvasW, canvasH } = vp;
  
  // Clear fog canvas
  fogCtx.clearRect(0, 0, canvasW, canvasH);
  
  // Fill with fog
  fogCtx.fillStyle = CONFIG.fogColor;
  fogCtx.fillRect(0, 0, canvasW, canvasH);
  
  // Cut out revealed tiles
  fogCtx.globalCompositeOperation = 'destination-out';
  fogCtx.fillStyle = 'white';
  
  // Only process tiles in view
  const startX = Math.max(0, Math.floor(left) - 1);
  const startY = Math.max(0, Math.floor(top) - 1);
  const endX = Math.min(gameState.map.meta.width, Math.ceil(right) + 1);
  const endY = Math.min(gameState.map.meta.height, Math.ceil(bottom) + 1);
  
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const key = `${x},${y}`;
      if (revealed.has(key)) {
        const screenPos = worldToScreen(x, y);
        if (screenPos) {
          // Draw slightly larger to avoid gaps
          fogCtx.fillRect(
            screenPos.x - 0.5,
            screenPos.y - 0.5,
            pixelsPerTile + 1,
            pixelsPerTile + 1
          );
        }
      }
    }
  }
  
  fogCtx.globalCompositeOperation = 'source-over';
}

function renderRegions(vp) {
  if (!gameState.map.regions) return;
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  
  for (const region of gameState.map.regions) {
    const b = region.bounds;
    
    // Check if region is in view
    if (b.x1 < vp.left || b.x0 > vp.right || b.y1 < vp.top || b.y0 > vp.bottom) {
      continue;
    }
    
    const topLeft = worldToScreen(b.x0, b.y0);
    const bottomRight = worldToScreen(b.x1, b.y1);
    
    if (topLeft && bottomRight) {
      ctx.strokeRect(
        topLeft.x,
        topLeft.y,
        bottomRight.x - topLeft.x,
        bottomRight.y - topLeft.y
      );
    }
  }
}

function renderEntities(vp) {
  // Render NPCs with type-based colors
  if (gameState.entities.npcs) {
    for (const npc of gameState.entities.npcs) {
      // Skip hidden NPCs
      if (npc.flags?.hidden) continue;
      
      // Check if in view and revealed
      if (!isInView(npc.x, npc.y, vp)) continue;
      if (!isRevealed(npc.x, npc.y)) continue;
      
      // Color based on NPC type (matching CSS hue-rotate values)
      const npcType = npc.type || npc.npcType || '';
      if (npcType === 'guard') {
        ctx.fillStyle = CONFIG.npcGuardColor;  // Cyan
      } else if (npcType === 'medic') {
        ctx.fillStyle = CONFIG.npcMedicColor;  // Pink
      } else {
        ctx.fillStyle = CONFIG.npcColor;       // Green (default)
      }
      
      const pos = worldToScreen(npc.x + 0.5, npc.y + 0.5);
      if (pos) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, CONFIG.entitySize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  
  // Render active enemies with state-based colors
  if (gameState.runtime.activeEnemies) {
    for (const enemy of gameState.runtime.activeEnemies) {
      if (enemy.hp <= 0) continue;
      
      // Check if in view and revealed
      if (!isInView(enemy.x, enemy.y, vp)) continue;
      if (!isRevealed(enemy.x, enemy.y)) continue;
      
      // Color based on enemy state (matching CSS classes/hue-rotate values)
      if (enemy.isAlpha) {
        ctx.fillStyle = CONFIG.enemyAlphaColor;    // Gold (alpha enemies)
      } else if (enemy.engaged || enemy.combat) {
        ctx.fillStyle = CONFIG.enemyEngagedColor;  // Red (hostile/in combat)
      } else if (enemy.passive) {
        ctx.fillStyle = CONFIG.enemyPassiveColor;  // Yellow (passive)
      } else {
        ctx.fillStyle = CONFIG.enemyPassiveColor;  // Default to passive yellow
      }
      
      const pos = worldToScreen(enemy.x + 0.5, enemy.y + 0.5);
      if (pos) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, CONFIG.entitySize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// Path markers cache (updated via dynamic import)
let cachedPath = [];
let pathUpdateScheduled = false;

function updatePathCache() {
  if (pathUpdateScheduled) return;
  pathUpdateScheduled = true;
  
  import('./movement.js').then(({ getCurrentPath }) => {
    cachedPath = getCurrentPath() || [];
    pathUpdateScheduled = false;
  }).catch(() => {
    cachedPath = [];
    pathUpdateScheduled = false;
  });
}

function renderPath(vp) {
  // Update path cache
  updatePathCache();
  
  if (!cachedPath || cachedPath.length === 0) return;
  
  const size = CONFIG.pathMarkerSize;
  const halfSize = size / 2;
  
  // Draw path markers as small squares
  for (let i = 0; i < cachedPath.length; i++) {
    const { x, y } = cachedPath[i];
    
    // Check if in view
    if (!isInView(x, y, vp)) continue;
    
    const pos = worldToScreen(x + 0.5, y + 0.5);
    if (!pos) continue;
    
    // Opacity increases along path (more opaque near destination)
    const opacity = 0.4 + (i / cachedPath.length) * 0.5;
    
    // Draw square marker with stroke
    ctx.fillStyle = CONFIG.pathColor;
    ctx.globalAlpha = opacity;
    ctx.fillRect(pos.x - halfSize, pos.y - halfSize, size, size);
    
    // Stroke
    ctx.strokeStyle = CONFIG.pathStroke;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(pos.x - halfSize, pos.y - halfSize, size, size);
    
    ctx.globalAlpha = 1;
  }
}

function renderPlayer(_vp) {
  // Player dot rendered at camera position (always centered, world moves around it)
  const pos = worldToScreen(cameraX + 0.5, cameraY + 0.5);
  if (!pos) return;
  
  // Subtle glow effect
  ctx.fillStyle = CONFIG.playerGlow;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, CONFIG.playerSize + 1.5, 0, Math.PI * 2);
  ctx.fill();
  
  // Player dot - square to match path markers
  ctx.fillStyle = CONFIG.playerColor;
  const playerHalf = CONFIG.playerSize / 2;
  ctx.fillRect(pos.x - playerHalf, pos.y - playerHalf, CONFIG.playerSize, CONFIG.playerSize);
  
  // Dark border to match sprite outline
  ctx.strokeStyle = CONFIG.playerStroke;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(pos.x - playerHalf, pos.y - playerHalf, CONFIG.playerSize, CONFIG.playerSize);
}

function isInView(x, y, vp) {
  return x >= vp.left - 1 && x <= vp.right + 1 && y >= vp.top - 1 && y <= vp.bottom + 1;
}

function isRevealed(x, y) {
  if (!gameState.runtime.revealedTiles) return true;
  return gameState.runtime.revealedTiles.has(`${x},${y}`);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Update the minimap - call this when player moves
 */
export function updateMinimap() {
  scheduleRender();
}

/**
 * Force immediate render
 */
export function forceRender() {
  render();
}

/**
 * Add a marker at world position (e.g., corpse)
 */
let markers = new Map();

export function addMarker(id, x, y, emoji, onClick) {
  markers.set(id, { x, y, emoji, onClick });
  scheduleRender();
}

export function removeMarker(id) {
  markers.delete(id);
  scheduleRender();
}

export function clearMarkers() {
  markers.clear();
  scheduleRender();
}

/**
 * Cleanup
 */
export function destroyMinimap() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  
  container?.removeEventListener('wheel', onWheel);
  container?.removeEventListener('click', onClick);
  
  canvas = null;
  ctx = null;
  fogCanvas = null;
  fogCtx = null;
  container = null;
  gameState = null;
  terrainImageData = null;
}

