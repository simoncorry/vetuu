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
  
  // Colors
  playerColor: '#69d2d6',
  playerGlow: 'rgba(105, 210, 214, 0.6)',
  npcColor: '#4CAF50',
  enemyColor: '#e74c3c',
  fogColor: 'rgba(13, 15, 17, 0.92)',
  
  // Sizes (in canvas pixels)
  playerSize: 6,
  entitySize: 4,
  
  // Performance
  renderThrottle: 50, // ms between renders
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
let lastRenderTime = 0;
let renderScheduled = false;
let resizeObserver = null;

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
  
  // Initial render
  render();
  
  console.log('[Minimap] Initialized with view radius:', viewRadius);
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
  
  const player = gameState.player;
  const canvasW = canvas.width;
  const canvasH = canvas.height;
  
  // Calculate pixels per tile based on view radius and canvas size
  // We want viewRadius*2 tiles to fit in the smaller dimension
  const tilesVisible = viewRadius * 2;
  const pixelsPerTile = Math.min(canvasW, canvasH) / tilesVisible;
  
  // Calculate world bounds visible in the viewport
  const tilesX = canvasW / pixelsPerTile;
  const tilesY = canvasH / pixelsPerTile;
  
  return {
    // Center on player
    centerX: player.x,
    centerY: player.y,
    // World tile bounds
    left: player.x - tilesX / 2,
    top: player.y - tilesY / 2,
    right: player.x + tilesX / 2,
    bottom: player.y + tilesY / 2,
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
  
  // Draw player (always on top, always centered)
  renderPlayer(vp);
  
  lastRenderTime = performance.now();
}

function renderTerrain(vp) {
  if (!terrainImageData) return;
  
  const { left, top, tilesX, tilesY, pixelsPerTile, canvasW, canvasH } = vp;
  
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
  // Render NPCs
  if (gameState.entities.npcs) {
    ctx.fillStyle = CONFIG.npcColor;
    
    for (const npc of gameState.entities.npcs) {
      // Skip hidden NPCs
      if (npc.flags?.hidden) continue;
      
      // Check if in view and revealed
      if (!isInView(npc.x, npc.y, vp)) continue;
      if (!isRevealed(npc.x, npc.y)) continue;
      
      const pos = worldToScreen(npc.x + 0.5, npc.y + 0.5);
      if (pos) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, CONFIG.entitySize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  
  // Render active enemies
  if (gameState.runtime.activeEnemies) {
    ctx.fillStyle = CONFIG.enemyColor;
    
    for (const enemy of gameState.runtime.activeEnemies) {
      if (enemy.hp <= 0) continue;
      
      // Check if in view and revealed
      if (!isInView(enemy.x, enemy.y, vp)) continue;
      if (!isRevealed(enemy.x, enemy.y)) continue;
      
      const pos = worldToScreen(enemy.x + 0.5, enemy.y + 0.5);
      if (pos) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, CONFIG.entitySize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function renderPlayer(vp) {
  // Player is always at center
  const pos = worldToScreen(gameState.player.x + 0.5, gameState.player.y + 0.5);
  if (!pos) return;
  
  // Glow effect
  ctx.fillStyle = CONFIG.playerGlow;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, CONFIG.playerSize + 2, 0, Math.PI * 2);
  ctx.fill();
  
  // Player dot
  ctx.fillStyle = CONFIG.playerColor;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, CONFIG.playerSize / 2, 0, Math.PI * 2);
  ctx.fill();
  
  // White border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
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

