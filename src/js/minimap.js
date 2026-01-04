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

import { isRevealed as fogIsRevealed } from './fog.js';

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
let resizeObserver = null;
let animationFrameId = null;

// Camera position (smoothly interpolated toward player)
let cameraX = 0;
let cameraY = 0;
let lastFrameTime = 0;

// Player facing direction (for minimap indicator)
// 0 = right, 1 = down-right, 2 = down, 3 = down-left, 4 = left, 5 = up-left, 6 = up, 7 = up-right
let playerFacing = 2; // Default to down/south
let lastPlayerX = 0;
let lastPlayerY = 0;

// Smoothing - pixels per second approach for frame-rate independence
const CAMERA_SPEED = 8; // tiles per second base speed

// Cached references
let gameState = null;
let terrainImageData = null;

// Performance: cached interactable objects (filtered once, not every frame)
let cachedInteractables = null;

// Performance: cached path module reference (avoid dynamic import in render loop)
let movementModule = null;

// Performance: dirty flag to skip unnecessary renders
let needsRender = true;
let lastCameraX = 0;
let lastCameraY = 0;

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
  
  // Pre-load movement module to avoid dynamic import in render loop
  import('./movement.js').then(mod => {
    movementModule = mod;
  }).catch(() => {});
  
  function loop(timestamp) {
    updateCamera(timestamp);
    
    // Only render if camera moved or render was explicitly requested
    const cameraMoved = Math.abs(cameraX - lastCameraX) > 0.01 || Math.abs(cameraY - lastCameraY) > 0.01;
    if (cameraMoved || needsRender) {
      render();
      lastCameraX = cameraX;
      lastCameraY = cameraY;
      needsRender = false;
    }
    
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
  
  // Track player facing direction based on movement (8 directions)
  const moveDx = targetX - lastPlayerX;
  const moveDy = targetY - lastPlayerY;
  if (Math.abs(moveDx) > 0.1 || Math.abs(moveDy) > 0.1) {
    // Determine direction using 8-way compass
    const absDx = Math.abs(moveDx);
    const absDy = Math.abs(moveDy);
    const isDiagonal = absDx > 0.05 && absDy > 0.05 && absDx / absDy < 2 && absDy / absDx < 2;
    
    if (isDiagonal) {
      // Diagonal movement
      if (moveDx > 0 && moveDy > 0) playerFacing = 1;      // Down-right
      else if (moveDx < 0 && moveDy > 0) playerFacing = 3; // Down-left
      else if (moveDx < 0 && moveDy < 0) playerFacing = 5; // Up-left
      else playerFacing = 7;                                // Up-right
    } else {
      // Cardinal movement
      if (absDx > absDy) {
        playerFacing = moveDx > 0 ? 0 : 4; // Right or Left
      } else {
        playerFacing = moveDy > 0 ? 2 : 6; // Down or Up
      }
    }
    lastPlayerX = targetX;
    lastPlayerY = targetY;
  }
  
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

// Cached viewport for current frame (set at start of render)
let currentVp = null;

function worldToScreen(worldX, worldY) {
  // Use cached viewport from current render frame
  const vp = currentVp;
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
  // Just mark as needing render - the render loop will pick it up
  needsRender = true;
}

function render() {
  if (!ctx || !gameState || !canvas.width || !canvas.height) return;
  
  const vp = getViewport();
  if (!vp) return;
  
  // Cache viewport for worldToScreen calls this frame
  currentVp = vp;
  
  // Clear canvas
  ctx.fillStyle = '#0d0f11';
  ctx.fillRect(0, 0, vp.canvasW, vp.canvasH);
  
  // Draw terrain
  renderTerrain(vp);
  
  // Draw fog of war
  renderFog(vp);
  
  // Draw regions/POIs
  renderRegions(vp);
  
  // Draw entities (NPCs only - enemies drawn separately after fog)
  renderEntities(vp);
  
  // Draw path markers (between entities and player)
  renderPath(vp);
  
  // Draw player (always on top, always centered)
  renderPlayer(vp);
  
  // Draw interactable objects
  renderObjects(vp);
  
  // Draw enemies last, on fog canvas, so they're visible above fog
  renderEnemies(vp);
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
  
  // Pre-calculate screen offset for performance
  const offsetX = -left * pixelsPerTile;
  const offsetY = -top * pixelsPerTile;
  const tileDrawSize = pixelsPerTile + 1;
  
  // Use fog module's isRevealed (direct array lookup, no string allocation)
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      if (fogIsRevealed(x, y)) {
        // Inline screen position calculation (avoid function call overhead)
        const screenX = x * pixelsPerTile + offsetX - 0.5;
        const screenY = y * pixelsPerTile + offsetY - 0.5;
        fogCtx.fillRect(screenX, screenY, tileDrawSize, tileDrawSize);
      }
    }
  }
  
  fogCtx.globalCompositeOperation = 'source-over';
}

function renderRegions(vp) {
  if (!gameState.map.regions || !fogCtx) return;
  
  fogCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  fogCtx.lineWidth = 1;
  
  for (const region of gameState.map.regions) {
    const b = region.bounds;
    
    // Check if region is in view
    if (b.x1 < vp.left || b.x0 > vp.right || b.y1 < vp.top || b.y0 > vp.bottom) {
      continue;
    }
    
    const topLeft = worldToScreen(b.x0, b.y0);
    const bottomRight = worldToScreen(b.x1, b.y1);
    
    if (topLeft && bottomRight) {
      fogCtx.strokeRect(
        topLeft.x,
        topLeft.y,
        bottomRight.x - topLeft.x,
        bottomRight.y - topLeft.y
      );
    }
  }
}

function renderEntities(vp) {
  if (!fogCtx) return;
  
  const npcs = gameState.entities?.npcs;
  if (!npcs || npcs.length === 0) return;
  
  // NPC square size
  const npcSize = 6;
  const halfSize = npcSize / 2;
  
  // Pre-set stroke style (same for all NPCs)
  fogCtx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  fogCtx.lineWidth = 1;
  
  // Render NPCs with type-based colors on fog canvas
  for (const npc of npcs) {
    // Skip hidden NPCs
    if (npc.flags?.hidden) continue;
    
    // Check if in view and revealed
    if (!isInView(npc.x, npc.y, vp)) continue;
    if (!isRevealed(npc.x, npc.y)) continue;
    
    // Color based on NPC type - use brighter colors
    if (npc.isGuard || npc.role === 'guard') {
      fogCtx.fillStyle = '#00DDDD';  // Bright cyan
    } else if (npc.isMedic || npc.role === 'medic') {
      fogCtx.fillStyle = '#FF69B4';  // Hot pink
    } else {
      fogCtx.fillStyle = '#44FF44';  // Bright green
    }
    
    const pos = worldToScreen(npc.x + 0.5, npc.y + 0.5);
    if (pos) {
      // Draw NPC square with dark border (8-bit style)
      fogCtx.fillRect(pos.x - halfSize, pos.y - halfSize, npcSize, npcSize);
      fogCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, npcSize, npcSize);
    }
  }
}

function renderObjects(vp) {
  if (!fogCtx) return;
  
  // Cache interactable objects once (not every frame)
  if (!cachedInteractables && gameState.map?.objects) {
    cachedInteractables = gameState.map.objects.filter(obj => obj.interact);
  }
  
  if (!cachedInteractables || cachedInteractables.length === 0) return;
  
  // Object square size
  const objSize = 6;
  const halfSize = objSize / 2;
  
  // Pre-set stroke style (same for all objects)
  fogCtx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  fogCtx.lineWidth = 1;
  
  for (const obj of cachedInteractables) {
    // Skip collected nodes
    if (gameState.runtime?.collectedNodes?.has(obj.id)) continue;
    
    // Check if in view and revealed
    if (!isInView(obj.x, obj.y, vp)) continue;
    if (!isRevealed(obj.x, obj.y)) continue;
    
    const pos = worldToScreen(obj.x + 0.5, obj.y + 0.5);
    if (!pos) continue;
    
    // Color based on interaction type
    const action = obj.interact.action;
    if (action === 'collect') {
      fogCtx.fillStyle = '#AA66FF';  // Purple for collectibles
    } else if (action === 'read') {
      fogCtx.fillStyle = '#6699FF';  // Blue for readable/lore
    } else if (action === 'loot') {
      fogCtx.fillStyle = '#FFAA44';  // Orange for loot
    } else {
      fogCtx.fillStyle = '#BB88FF';  // Light purple default
    }
    
    // Draw object square with dark border (8-bit style)
    fogCtx.fillRect(pos.x - halfSize, pos.y - halfSize, objSize, objSize);
    fogCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, objSize, objSize);
  }
}

function renderEnemies(vp) {
  if (!fogCtx) return;
  
  const enemies = gameState.runtime?.activeEnemies;
  if (!enemies || enemies.length === 0) return;
  
  // Enemy square size
  const enemySize = 6;
  const halfSize = enemySize / 2;
  
  // Pre-set stroke style (same for all enemies)
  fogCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  fogCtx.lineWidth = 1;
  
  // Cache bounds for faster comparison
  const minX = -10;
  const maxX = vp.canvasW + 10;
  const minY = -10;
  const maxY = vp.canvasH + 10;
  
  for (const enemy of enemies) {
    // Skip dead enemies
    if (enemy.hp <= 0) continue;
    
    // Skip enemies in unexplored fog (proper fog of war)
    if (!isRevealed(enemy.x, enemy.y)) continue;
    
    // Get screen position
    const pos = worldToScreen(enemy.x + 0.5, enemy.y + 0.5);
    if (!pos) continue;
    
    // Skip if outside canvas bounds
    if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) continue;
    
    // Color based on enemy state - use brighter, more saturated colors
    if (enemy.isAlpha) {
      fogCtx.fillStyle = '#FFD700';  // Bright gold
    } else if (enemy.engaged || enemy.combat) {
      fogCtx.fillStyle = '#FF4444';  // Bright red
    } else {
      fogCtx.fillStyle = '#FFAA00';  // Bright orange-yellow
    }
    
    // Draw enemy square with dark border for contrast (8-bit style)
    fogCtx.fillRect(pos.x - halfSize, pos.y - halfSize, enemySize, enemySize);
    fogCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, enemySize, enemySize);
  }
}

// Path markers cache
let cachedPath = [];

function updatePathCache() {
  // Use pre-loaded module reference (no dynamic import in render loop)
  if (movementModule?.getCurrentPath) {
    cachedPath = movementModule.getCurrentPath() || [];
  }
}

function renderPath(vp) {
  if (!fogCtx) return;
  
  // Update path cache
  updatePathCache();
  
  if (!cachedPath || cachedPath.length === 0) return;
  
  const size = CONFIG.pathMarkerSize;
  const halfSize = size / 2;
  const pathLen = cachedPath.length;
  
  // Pre-set styles
  fogCtx.fillStyle = CONFIG.pathColor;
  fogCtx.strokeStyle = CONFIG.pathStroke;
  fogCtx.lineWidth = 0.5;
  
  // Draw path markers as small squares on fog canvas (above fog layer)
  for (let i = 0; i < pathLen; i++) {
    const { x, y } = cachedPath[i];
    
    // Check if in view
    if (!isInView(x, y, vp)) continue;
    
    const pos = worldToScreen(x + 0.5, y + 0.5);
    if (!pos) continue;
    
    // Opacity increases along path (more opaque near destination)
    fogCtx.globalAlpha = 0.4 + (i / pathLen) * 0.5;
    
    // Draw square marker with stroke
    fogCtx.fillRect(pos.x - halfSize, pos.y - halfSize, size, size);
    fogCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, size, size);
  }
  
  fogCtx.globalAlpha = 1;
}

function renderPlayer(_vp) {
  if (!fogCtx) return;
  
  // Player square rendered at camera position (always centered, world moves around it)
  const pos = worldToScreen(cameraX + 0.5, cameraY + 0.5);
  if (!pos) return;
  
  // Player square size (10x10)
  const playerSize = 10;
  const halfSize = playerSize / 2;
  
  // Triangle size (6x6)
  const triSize = 6;
  const halfTriSize = triSize / 2;
  
  // Player square - white/off-white to stand out from all other colors
  fogCtx.fillStyle = '#EEEEFF';
  fogCtx.fillRect(pos.x - halfSize, pos.y - halfSize, playerSize, playerSize);
  
  // Dark border
  fogCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  fogCtx.lineWidth = 1;
  fogCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, playerSize, playerSize);
  
  // Direction triangle indicator (6x6, dark color)
  fogCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  fogCtx.beginPath();
  
  // Diagonal offset for corner triangles
  const diagTriOffset = triSize * 0.707;
  
  // 0 = right, 1 = down-right, 2 = down, 3 = down-left, 4 = left, 5 = up-left, 6 = up, 7 = up-right
  switch (playerFacing) {
    case 0: // Right
      fogCtx.moveTo(pos.x + halfSize, pos.y - halfTriSize);
      fogCtx.lineTo(pos.x + halfSize + triSize, pos.y);
      fogCtx.lineTo(pos.x + halfSize, pos.y + halfTriSize);
      break;
    case 1: // Down-right (diagonal)
      fogCtx.moveTo(pos.x + halfSize, pos.y + halfSize - halfTriSize);
      fogCtx.lineTo(pos.x + halfSize + diagTriOffset, pos.y + halfSize + diagTriOffset);
      fogCtx.lineTo(pos.x + halfSize - halfTriSize, pos.y + halfSize);
      break;
    case 2: // Down
      fogCtx.moveTo(pos.x - halfTriSize, pos.y + halfSize);
      fogCtx.lineTo(pos.x, pos.y + halfSize + triSize);
      fogCtx.lineTo(pos.x + halfTriSize, pos.y + halfSize);
      break;
    case 3: // Down-left (diagonal)
      fogCtx.moveTo(pos.x - halfSize + halfTriSize, pos.y + halfSize);
      fogCtx.lineTo(pos.x - halfSize - diagTriOffset, pos.y + halfSize + diagTriOffset);
      fogCtx.lineTo(pos.x - halfSize, pos.y + halfSize - halfTriSize);
      break;
    case 4: // Left
      fogCtx.moveTo(pos.x - halfSize, pos.y - halfTriSize);
      fogCtx.lineTo(pos.x - halfSize - triSize, pos.y);
      fogCtx.lineTo(pos.x - halfSize, pos.y + halfTriSize);
      break;
    case 5: // Up-left (diagonal)
      fogCtx.moveTo(pos.x - halfSize, pos.y - halfSize + halfTriSize);
      fogCtx.lineTo(pos.x - halfSize - diagTriOffset, pos.y - halfSize - diagTriOffset);
      fogCtx.lineTo(pos.x - halfSize + halfTriSize, pos.y - halfSize);
      break;
    case 6: // Up
      fogCtx.moveTo(pos.x - halfTriSize, pos.y - halfSize);
      fogCtx.lineTo(pos.x, pos.y - halfSize - triSize);
      fogCtx.lineTo(pos.x + halfTriSize, pos.y - halfSize);
      break;
    case 7: // Up-right (diagonal)
      fogCtx.moveTo(pos.x + halfSize - halfTriSize, pos.y - halfSize);
      fogCtx.lineTo(pos.x + halfSize + diagTriOffset, pos.y - halfSize - diagTriOffset);
      fogCtx.lineTo(pos.x + halfSize, pos.y - halfSize + halfTriSize);
      break;
  }
  
  fogCtx.closePath();
  fogCtx.fill();
}

function isInView(x, y, vp) {
  return x >= vp.left - 1 && x <= vp.right + 1 && y >= vp.top - 1 && y <= vp.bottom + 1;
}

function isRevealed(x, y) {
  // Use fog module's isRevealed for O(1) array lookup (no string allocation)
  // Floor coordinates since enemies can have fractional positions during movement
  return fogIsRevealed(Math.floor(x), Math.floor(y));
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
 * Debug: Log minimap state for troubleshooting
 */
export function debugMinimap() {
  const vp = getViewport();
  const enemies = gameState?.runtime?.activeEnemies || [];
  const npcs = gameState?.entities?.npcs || [];
  
  console.log('[Minimap Debug]');
  console.log('  Viewport:', vp);
  console.log('  Canvas:', canvas?.width, 'x', canvas?.height);
  console.log('  Total enemies:', enemies.length);
  console.log('  Total NPCs:', npcs.length);
  console.log('  Fog: Using direct array lookup (fogIsRevealed)');
  
  // Check each enemy
  let visibleCount = 0;
  let inViewCount = 0;
  let revealedCount = 0;
  let aliveCount = 0;
  
  for (const enemy of enemies) {
    if (enemy.hp > 0) aliveCount++;
    if (vp && isInView(enemy.x, enemy.y, vp)) inViewCount++;
    if (isRevealed(enemy.x, enemy.y)) revealedCount++;
    if (enemy.hp > 0 && vp && isInView(enemy.x, enemy.y, vp) && isRevealed(enemy.x, enemy.y)) {
      visibleCount++;
    }
  }
  
  console.log('  Enemy breakdown:');
  console.log('    Alive:', aliveCount);
  console.log('    In view:', inViewCount);
  console.log('    In revealed area:', revealedCount);
  console.log('    Should be visible:', visibleCount);
  
  // Sample first few enemies
  if (enemies.length > 0) {
    console.log('  First 3 enemies:');
    enemies.slice(0, 3).forEach((e, i) => {
      const inView = vp && isInView(e.x, e.y, vp);
      const revealed = isRevealed(e.x, e.y);
      console.log(`    [${i}] ${e.name} at (${e.x}, ${e.y}) hp=${e.hp} inView=${inView} revealed=${revealed}`);
    });
  }
  
  return { enemies: enemies.length, visible: visibleCount, viewport: vp };
}

// Expose to console
if (typeof window !== 'undefined') {
  window.VETUU_MINIMAP_DEBUG = debugMinimap;
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

