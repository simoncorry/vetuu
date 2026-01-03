/**
 * VETUU — Fog of War Module
 * Viewport-based canvas rendering for performance on large maps
 * 
 * Instead of an 11,520×7,680 canvas (88M pixels), we use a viewport-sized
 * canvas (~1500×1100 pixels) that repositions with the camera.
 */

import { perfStart, perfEnd } from './perf.js';

// Note: TILE_SIZE kept local to avoid circular import with render.js
const TILE_SIZE = 24;
const ZOOM_FACTOR = 1.5;
const REVEAL_RADIUS = 8;
const FOG_STORAGE_KEY = 'vetuu_fog_v2';

// Buffer tiles around viewport (prevents constant re-renders during movement)
const BUFFER_TILES = 10;
// Threshold before repositioning canvas (when player moves this far from center)
const REPOSITION_THRESHOLD = 6;

let fogCanvas = null;
let fogCtx = null;
let fogMask = null; // 2D array: true = revealed
let mapWidth = 0;
let mapHeight = 0;

// Viewport canvas tracking
let canvasOffsetX = 0; // Top-left tile X of canvas in world coords
let canvasOffsetY = 0; // Top-left tile Y of canvas in world coords
let canvasTilesW = 0;  // Canvas width in tiles
let canvasTilesH = 0;  // Canvas height in tiles
let lastCenterX = 0;   // Last camera center for threshold check
let lastCenterY = 0;
let lastUpdateX = -1;  // Last tile position for early-return optimization
let lastUpdateY = -1;

// Pre-rendered dither stamps (ImageData for fast blitting)
let ditherStampFull = null;   // Full fog tile
let ditherStampInner = null;  // Inner dither (threshold 8)
let ditherStampOuter = null;  // Outer dither (threshold 12)

// ============================================
// INITIALIZATION
// ============================================
export function initFog(state) {
  const viewport = document.getElementById('viewport');
  const fogLayer = document.getElementById('fog-layer');
  
  mapWidth = state.map.meta.width;
  mapHeight = state.map.meta.height;
  
  // Calculate viewport size in tiles (at zoom scale) + buffer
  const viewportW = viewport?.clientWidth || 1200;
  const viewportH = viewport?.clientHeight || 800;
  canvasTilesW = Math.ceil(viewportW / ZOOM_FACTOR / TILE_SIZE) + BUFFER_TILES * 2;
  canvasTilesH = Math.ceil(viewportH / ZOOM_FACTOR / TILE_SIZE) + BUFFER_TILES * 2;
  
  // Clamp to map size (for small maps)
  canvasTilesW = Math.min(canvasTilesW, mapWidth);
  canvasTilesH = Math.min(canvasTilesH, mapHeight);
  
  // Create viewport-sized fog canvas (MUCH smaller than full map)
  fogCanvas = document.createElement('canvas');
  fogCanvas.id = 'fog-canvas';
  fogCanvas.width = canvasTilesW * TILE_SIZE;
  fogCanvas.height = canvasTilesH * TILE_SIZE;
  fogCanvas.style.cssText = 'position: absolute; top: 0; left: 0; pointer-events: none; will-change: transform;';
  
  fogLayer.innerHTML = '';
  fogLayer.appendChild(fogCanvas);
  
  fogCtx = fogCanvas.getContext('2d');

  // Pre-render dither stamps for fast blitting
  createDitherStamps();

  // Initialize revealed tiles set
  state.runtime.revealedTiles = new Set();

  // Load saved fog or create new
  const saved = loadFogMask();
  if (saved && saved.length === mapHeight && saved[0]?.length === mapWidth) {
    fogMask = saved;
    
    // Populate revealedTiles from saved mask
    for (let y = 0; y < mapHeight; y++) {
      for (let x = 0; x < mapWidth; x++) {
        if (fogMask[y][x]) {
          state.runtime.revealedTiles.add(`${x},${y}`);
        }
      }
    }
  } else {
    // Clear old fog data if dimensions don't match
    localStorage.removeItem(FOG_STORAGE_KEY);
    fogMask = Array.from({ length: mapHeight }, () =>
      Array.from({ length: mapWidth }, () => false)
    );
  }

  // Reveal starting area around player
  revealAround(state, state.player.x, state.player.y, 10);

  // Reveal Drycross base region with buffer
  revealDrycrossBase(state);

  // Position canvas at player and render
  repositionFogCanvas(state.player.x, state.player.y);
  renderFogViewport();
  
  console.log(`[Fog] Viewport canvas: ${fogCanvas.width}×${fogCanvas.height}px (${canvasTilesW}×${canvasTilesH} tiles)`);
  console.log(`[Fog] vs full map would be: ${mapWidth * TILE_SIZE}×${mapHeight * TILE_SIZE}px`);
}

/**
 * Simple seeded random for consistent jagged edges.
 */
function seededRandom(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Reveal the Drycross base and surrounding area on game start.
 * Reveals a circular area around the base center + 12 tiles beyond walls.
 * Base is a rounded rectangle but fog reveal is circular for natural look.
 */
function revealDrycrossBase(state) {
  const BUFFER = 12;        // Tiles beyond walls to reveal
  const JAGGED_AMOUNT = 5;  // Random variation at edges
  
  // Find Drycross region
  const drycross = state.map.regions?.find(r => r.id === 'region_drycross');
  if (!drycross) return;
  
  // Get map offset for expanded coordinates
  const offset = state.map.meta.originalOffset || { x: 0, y: 0 };
  
  // Base center
  const centerX = Math.floor((drycross.bounds.x0 + drycross.bounds.x1) / 2) + offset.x;
  const centerY = Math.floor((drycross.bounds.y0 + drycross.bounds.y1) / 2) + offset.y;
  
  // Calculate base half-dimensions to determine reveal radius
  const halfWidth = Math.floor((drycross.bounds.x1 - drycross.bounds.x0) / 2);
  const halfHeight = Math.floor((drycross.bounds.y1 - drycross.bounds.y0) / 2);
  
  // Use the larger dimension + buffer as reveal radius
  const BASE_RADIUS = Math.max(halfWidth, halfHeight);
  const CORE_RADIUS = BASE_RADIUS + BUFFER;
  const OUTER_RADIUS = CORE_RADIUS + JAGGED_AMOUNT;
  
  // Scan area
  const startX = Math.max(0, centerX - OUTER_RADIUS);
  const startY = Math.max(0, centerY - OUTER_RADIUS);
  const endX = Math.min(mapWidth - 1, centerX + OUTER_RADIUS);
  const endY = Math.min(mapHeight - 1, centerY + OUTER_RADIUS);
  
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      if (fogMask[y][x]) continue; // Already revealed
      
      // Calculate distance from center
      const dist = Math.hypot(x - centerX, y - centerY);
      
      // Inside core radius - always reveal
      if (dist <= CORE_RADIUS) {
        fogMask[y][x] = true;
        state.runtime.revealedTiles.add(`${x},${y}`);
        continue;
      }
      
      // Jagged edge falloff
      const jitter = (seededRandom(x, y) - 0.5) * 2 * JAGGED_AMOUNT;
      const effectiveRadius = CORE_RADIUS + JAGGED_AMOUNT + jitter;
      
      if (dist <= effectiveRadius) {
        const falloffDist = dist - CORE_RADIUS;
        const revealChance = 1 - (falloffDist / (JAGGED_AMOUNT * 2));
        if (seededRandom(x + 100, y + 100) < revealChance) {
          fogMask[y][x] = true;
          state.runtime.revealedTiles.add(`${x},${y}`);
        }
      }
    }
  }
  
  saveFogMask();
}

// ============================================
// VIEWPORT CANVAS POSITIONING
// ============================================

/**
 * Reposition the fog canvas to be centered around a world position.
 * Called when camera moves beyond threshold.
 */
function repositionFogCanvas(centerX, centerY) {
  // Calculate new canvas offset (top-left corner in tile coordinates)
  const halfW = Math.floor(canvasTilesW / 2);
  const halfH = Math.floor(canvasTilesH / 2);
  
  let newOffsetX = centerX - halfW;
  let newOffsetY = centerY - halfH;
  
  // Clamp to map bounds
  newOffsetX = Math.max(0, Math.min(newOffsetX, mapWidth - canvasTilesW));
  newOffsetY = Math.max(0, Math.min(newOffsetY, mapHeight - canvasTilesH));
  
  canvasOffsetX = newOffsetX;
  canvasOffsetY = newOffsetY;
  lastCenterX = centerX;
  lastCenterY = centerY;
  
  // Position the canvas in world coordinates (GPU-accelerated)
  fogCanvas.style.transform = `translate3d(${canvasOffsetX * TILE_SIZE}px, ${canvasOffsetY * TILE_SIZE}px, 0)`;
}

/**
 * Check if canvas needs repositioning based on camera center.
 * Returns true if repositioned (caller should re-render).
 */
function checkRepositionNeeded(centerX, centerY) {
  const dx = Math.abs(centerX - lastCenterX);
  const dy = Math.abs(centerY - lastCenterY);
  
  if (dx > REPOSITION_THRESHOLD || dy > REPOSITION_THRESHOLD) {
    repositionFogCanvas(centerX, centerY);
    return true;
  }
  return false;
}

// ============================================
// REVEAL MECHANICS
// ============================================

// Fog visual states
const FOG_STATE = {
  REVEALED: 0,
  INNER_DITHER: 1,  // 8/16 pixels (sparse)
  OUTER_DITHER: 2,  // 12/16 pixels (dense)
  SOLID: 3
};

/**
 * Get the visual fog state for a tile based on current fogMask.
 */
function getTileState(x, y) {
  if (fogMask[y]?.[x]) return FOG_STATE.REVEALED;
  const dist = getDistanceToRevealed(x, y, 2);
  if (dist === 1) return FOG_STATE.INNER_DITHER;
  if (dist === 2) return FOG_STATE.OUTER_DITHER;
  return FOG_STATE.SOLID;
}

/**
 * Create a fade element for a state transition.
 * The fade shows what's DISAPPEARING (the old state pixels that won't be in new state).
 */
function createFogFadeElement(x, y, fromState, toState) {
  // No fade needed if state didn't change visually
  if (fromState === toState) return;
  if (fromState === FOG_STATE.REVEALED) return; // Can't fade from revealed
  
  const fogLayer = document.getElementById('fog-layer');
  if (!fogLayer) return;
  
  const el = document.createElement('div');
  el.className = 'fog-fade';
  el.style.setProperty('--pos-x', `${x * TILE_SIZE}px`);
  el.style.setProperty('--pos-y', `${y * TILE_SIZE}px`);
  
  // Choose the right dither pattern based on transition
  if (toState === FOG_STATE.REVEALED) {
    // Inner dither → revealed: fade out the sparse inner pattern
    el.classList.add('fog-fade-inner');
  } else if (fromState === FOG_STATE.OUTER_DITHER && toState === FOG_STATE.INNER_DITHER) {
    // Outer dither → inner dither: fade out the 4 extra pixels
    el.classList.add('fog-fade-mid');
  } else if (fromState === FOG_STATE.SOLID && toState === FOG_STATE.OUTER_DITHER) {
    // Solid → outer dither: fade out the 4 pixels that become transparent
    el.classList.add('fog-fade-outer');
  } else if (fromState === FOG_STATE.SOLID && toState === FOG_STATE.INNER_DITHER) {
    // Solid → inner dither (skipped outer): fade the inner pattern
    el.classList.add('fog-fade-inner');
  } else if (fromState === FOG_STATE.INNER_DITHER && toState === FOG_STATE.REVEALED) {
    // This is handled by the first case
    el.classList.add('fog-fade-inner');
  }
  
  fogLayer.appendChild(el);
  
  // Remove after animation completes (250ms)
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// Track tiles that changed for batched fade animation
let pendingFadeUpdates = [];
let fadeUpdateScheduled = false;

export function revealAround(state, centerX, centerY, radius = REVEAL_RADIUS) {
  // Ensure runtime.revealedTiles exists
  if (!state.runtime.revealedTiles) {
    state.runtime.revealedTiles = new Set();
  }

  // Quick check: if center tile is already revealed with full radius, skip heavy work
  // This is the common case when walking in already-revealed areas
  let allRevealed = true;
  for (let dy = -radius; dy <= radius && allRevealed; dy++) {
    for (let dx = -radius; dx <= radius && allRevealed; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x >= 0 && y >= 0 && x < mapWidth && y < mapHeight) {
        const dist = Math.hypot(dx, dy);
        if (dist <= radius && !fogMask[y]?.[x]) {
          allRevealed = false;
        }
      }
    }
  }
  
  // Early return if nothing to reveal (most common case)
  if (allRevealed) return;
  
  // Update fogMask with newly revealed tiles
  let changed = false;
  const newlyRevealed = [];
  
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;

      // Bounds check
      if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight) continue;

      // Circular reveal
      const dist = Math.hypot(dx, dy);
      if (dist <= radius) {
        if (!fogMask[y][x]) {
          fogMask[y][x] = true;
          state.runtime.revealedTiles.add(`${x},${y}`);
          newlyRevealed.push({ x, y });
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveFogMask();
    
    // Queue fade updates instead of creating DOM elements immediately
    // This batches multiple reveals into a single DOM update
    for (const tile of newlyRevealed) {
      pendingFadeUpdates.push(tile);
    }
    
    // Schedule batched fade update on next frame
    if (!fadeUpdateScheduled) {
      fadeUpdateScheduled = true;
      requestAnimationFrame(processPendingFades);
    }
  }
}

function processPendingFades() {
  fadeUpdateScheduled = false;
  
  // Limit fade elements to prevent DOM overload
  const MAX_FADES = 20;
  const tiles = pendingFadeUpdates.splice(0, MAX_FADES);
  
  for (const { x, y } of tiles) {
    // Simple fade for newly revealed tiles
    createFogFadeElement(x, y, FOG_STATE.INNER_DITHER, FOG_STATE.REVEALED);
  }
  
  // If more pending, schedule another batch
  if (pendingFadeUpdates.length > 0) {
    fadeUpdateScheduled = true;
    requestAnimationFrame(processPendingFades);
  }
}

export function revealRegion(state, bounds) {
  // Ensure runtime.revealedTiles exists
  if (!state.runtime.revealedTiles) {
    state.runtime.revealedTiles = new Set();
  }

  // Translate bounds if needed (for expanded map)
  const offset = state.map.meta.originalOffset || { x: 0, y: 0 };
  const translatedBounds = {
    x0: bounds.x0 + offset.x,
    y0: bounds.y0 + offset.y,
    x1: bounds.x1 + offset.x,
    y1: bounds.y1 + offset.y
  };

  for (let y = translatedBounds.y0; y <= translatedBounds.y1; y++) {
    for (let x = translatedBounds.x0; x <= translatedBounds.x1; x++) {
      if (x >= 0 && y >= 0 && x < mapWidth && y < mapHeight) {
        fogMask[y][x] = true;
        state.runtime.revealedTiles.add(`${x},${y}`);
      }
    }
  }

  saveFogMask();
}

export function isRevealed(x, y) {
  if (!fogMask || y < 0 || y >= mapHeight || x < 0 || x >= mapWidth) return false;
  return fogMask[y]?.[x] === true;
}

// Get the fog mask for minimap
export function getFogMask() {
  return fogMask;
}

// ============================================
// FOG RENDERING (Viewport-based Canvas)
// ============================================

/**
 * Get the distance from a fogged tile to the nearest revealed tile.
 * Returns 0 if revealed, Infinity if no revealed neighbors within range.
 * Optimized: checks direct neighbors first (most common case).
 */
function getDistanceToRevealed(x, y, maxDist = 2) {
  if (fogMask[y]?.[x]) return 0; // Already revealed
  
  // Fast path: check immediate 4 neighbors (most common for dither edge)
  if (fogMask[y - 1]?.[x] || fogMask[y + 1]?.[x] || 
      fogMask[y]?.[x - 1] || fogMask[y]?.[x + 1]) {
    return 1;
  }
  
  // Check diagonal neighbors for distance 1
  if (fogMask[y - 1]?.[x - 1] || fogMask[y - 1]?.[x + 1] ||
      fogMask[y + 1]?.[x - 1] || fogMask[y + 1]?.[x + 1]) {
    return 1;
  }
  
  if (maxDist < 2) return Infinity;
  
  // Check distance 2 ring (only if needed)
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
      const ny = y + dy;
      const nx = x + dx;
      if (ny >= 0 && ny < mapHeight && nx >= 0 && nx < mapWidth) {
        if (fogMask[ny][nx]) return 2;
      }
    }
  }
  
  return Infinity;
}

/**
 * 8-bit Bayer dithering pattern (4x4 matrix).
 * Values 0-15, lower = more transparent at lower thresholds.
 */
const BAYER_4X4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5]
];

/**
 * Create pre-rendered dither stamp canvases for fast blitting.
 * Called once during init. Replaces per-tile per-pixel dithering work.
 */
function createDitherStamps() {
  const fogColor = [10, 12, 14, 242]; // rgba(10, 12, 14, 0.95) = ~242/255 alpha
  const cellSize = 4;
  const cells = TILE_SIZE / cellSize;
  
  // Helper to create a stamp canvas with given threshold
  function createStamp(threshold) {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d');
    
    // Create ImageData for pixel-level control
    const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const data = imageData.data;
    
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const bayerValue = BAYER_4X4[cy % 4][cx % 4];
        if (bayerValue < threshold) {
          // Fill this 4x4 cell
          for (let py = 0; py < cellSize; py++) {
            for (let px = 0; px < cellSize; px++) {
              const x = cx * cellSize + px;
              const y = cy * cellSize + py;
              const i = (y * TILE_SIZE + x) * 4;
              data[i] = fogColor[0];     // R
              data[i + 1] = fogColor[1]; // G
              data[i + 2] = fogColor[2]; // B
              data[i + 3] = fogColor[3]; // A
            }
          }
        }
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }
  
  // Full fog (threshold 16 = all pixels)
  ditherStampFull = createStamp(16);
  // Inner dither (threshold 8 = sparse)
  ditherStampInner = createStamp(8);
  // Outer dither (threshold 12 = dense)
  ditherStampOuter = createStamp(12);
}

/**
 * Draw a fog tile using pre-rendered stamps (fast drawImage).
 * @param {number} canvasX - X position on canvas (pixels)
 * @param {number} canvasY - Y position on canvas (pixels)
 * @param {'full'|'inner'|'outer'} type - Which dither pattern to use
 */
function drawFogTile(canvasX, canvasY, type) {
  const stamp = type === 'full' ? ditherStampFull :
                type === 'inner' ? ditherStampInner : ditherStampOuter;
  if (stamp) {
    fogCtx.drawImage(stamp, canvasX, canvasY);
  }
}

/**
 * Render fog for the current viewport canvas area.
 * Only draws tiles within the canvas bounds (canvasOffset → canvasOffset + canvasTiles).
 */
function renderFogViewport() {
  if (!fogCtx || !fogMask) return;
  
  perfStart('fog:renderViewport');

  // Clear canvas
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  
  // Calculate visible tile range (in world coordinates)
  const endX = Math.min(canvasOffsetX + canvasTilesW, mapWidth);
  const endY = Math.min(canvasOffsetY + canvasTilesH, mapHeight);
  
  // Render unrevealed tiles with dithering at edges (using pre-rendered stamps)
  for (let worldY = canvasOffsetY; worldY < endY; worldY++) {
    for (let worldX = canvasOffsetX; worldX < endX; worldX++) {
      if (!fogMask[worldY][worldX]) {
        // Convert world coords to canvas-local coords
        const canvasX = (worldX - canvasOffsetX) * TILE_SIZE;
        const canvasY = (worldY - canvasOffsetY) * TILE_SIZE;
        
        const distToRevealed = getDistanceToRevealed(worldX, worldY, 2);
        
        if (distToRevealed === 1) {
          // Innermost fog ring - sparse dither
          drawFogTile(canvasX, canvasY, 'inner');
        } else if (distToRevealed === 2) {
          // Second ring - denser dither
          drawFogTile(canvasX, canvasY, 'outer');
        } else {
          // Full fog
          drawFogTile(canvasX, canvasY, 'full');
        }
      }
    }
  }
  
  perfEnd('fog:renderViewport');
}

/**
 * Full fog render - repositions canvas and redraws.
 * Called on init and major state changes.
 */
export function renderFog(state) {
  if (!fogCtx || !fogMask) return;
  
  perfStart('fog:render');
  
  // Reposition around player if state provided
  if (state?.player) {
    repositionFogCanvas(state.player.x, state.player.y);
  }
  
  renderFogViewport();
  
  perfEnd('fog:render');
}

/**
 * Update fog for a local area (after revealing tiles).
 * Checks if canvas needs repositioning, then redraws affected tiles.
 */
export function updateFogArea(centerX, centerY, radius = REVEAL_RADIUS) {
  if (!fogCtx || !fogMask) return;
  
  // Early-return if player tile hasn't changed (prevents redundant redraws)
  if (centerX === lastUpdateX && centerY === lastUpdateY) {
    return;
  }
  lastUpdateX = centerX;
  lastUpdateY = centerY;
  
  // Check if we need to reposition the canvas
  const repositioned = checkRepositionNeeded(centerX, centerY);
  
  if (repositioned) {
    // Full redraw after repositioning
    perfStart('fog:update');
    renderFogViewport();
    perfEnd('fog:update');
    return;
  }
  
  // Quick check: if player is deep in revealed area, skip canvas update
  // Only need to update canvas when near fog boundary
  const margin = radius + 3;
  let nearFog = false;
  outer: for (let dy = -margin; dy <= margin && !nearFog; dy++) {
    for (let dx = -margin; dx <= margin && !nearFog; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x >= 0 && y >= 0 && x < mapWidth && y < mapHeight) {
        if (!fogMask[y][x]) {
          nearFog = true;
          break outer;
        }
      }
    }
  }
  
  // Skip expensive canvas update if nowhere near fog
  if (!nearFog) return;
  
  perfStart('fog:update');
  
  // Partial update - only redraw affected area
  const ditherMargin = 2;
  const startX = Math.max(canvasOffsetX, centerX - radius - ditherMargin);
  const startY = Math.max(canvasOffsetY, centerY - radius - ditherMargin);
  const endX = Math.min(canvasOffsetX + canvasTilesW, centerX + radius + 1 + ditherMargin);
  const endY = Math.min(canvasOffsetY + canvasTilesH, centerY + radius + 1 + ditherMargin);
  
  // Skip if area is entirely outside canvas
  if (startX >= endX || startY >= endY) {
    perfEnd('fog:update');
    return;
  }
  
  // Convert to canvas-local coordinates for clearRect
  const clearX = (startX - canvasOffsetX) * TILE_SIZE;
  const clearY = (startY - canvasOffsetY) * TILE_SIZE;
  const clearW = (endX - startX) * TILE_SIZE;
  const clearH = (endY - startY) * TILE_SIZE;
  
  // Clear and redraw just this area (using pre-rendered stamps)
  fogCtx.clearRect(clearX, clearY, clearW, clearH);
  
  for (let worldY = startY; worldY < endY; worldY++) {
    for (let worldX = startX; worldX < endX; worldX++) {
      if (!fogMask[worldY][worldX]) {
        const canvasX = (worldX - canvasOffsetX) * TILE_SIZE;
        const canvasY = (worldY - canvasOffsetY) * TILE_SIZE;
        
        const distToRevealed = getDistanceToRevealed(worldX, worldY, 2);
        
        if (distToRevealed === 1) {
          drawFogTile(canvasX, canvasY, 'inner');
        } else if (distToRevealed === 2) {
          drawFogTile(canvasX, canvasY, 'outer');
        } else {
          drawFogTile(canvasX, canvasY, 'full');
        }
      }
    }
  }
  
  perfEnd('fog:update');
}

// ============================================
// PERSISTENCE (with debouncing to reduce localStorage writes)
// ============================================
let fogSaveTimeout = null;
const FOG_SAVE_DEBOUNCE_MS = 2000; // Only save every 2 seconds max

function saveFogMask() {
  // Debounce saves to avoid hammering localStorage
  if (fogSaveTimeout) {
    clearTimeout(fogSaveTimeout);
  }
  
  fogSaveTimeout = setTimeout(() => {
    saveFogMaskNow();
    fogSaveTimeout = null;
  }, FOG_SAVE_DEBOUNCE_MS);
}

function saveFogMaskNow() {
  try {
    // Run-length encode for efficiency
    const compressed = fogMask.map(row => {
      let result = '';
      let count = 0;
      let current = row[0];
      
      for (const v of row) {
        if (v === current) {
          count++;
        } else {
          result += (current ? '1' : '0') + count.toString(36) + ',';
          current = v;
          count = 1;
        }
      }
      result += (current ? '1' : '0') + count.toString(36);
      return result;
    });
    
    localStorage.setItem(FOG_STORAGE_KEY, JSON.stringify({
      width: mapWidth,
      height: mapHeight,
      data: compressed
    }));
  } catch (e) {
    console.warn('Failed to save fog mask:', e);
  }
}

function loadFogMask() {
  try {
    const raw = localStorage.getItem(FOG_STORAGE_KEY);
    if (!raw) return null;

    const { width, height, data } = JSON.parse(raw);
    if (width !== mapWidth || height !== mapHeight) return null;

    // Decode run-length encoding
    return data.map(row => {
      const result = [];
      const parts = row.split(',');
      
      for (const part of parts) {
        if (!part) continue;
        const value = part[0] === '1';
        const count = parseInt(part.slice(1), 36);
        for (let i = 0; i < count; i++) {
          result.push(value);
        }
      }
      return result;
    });
  } catch (e) {
    console.warn('Failed to load fog mask:', e);
    return null;
  }
}

export function clearFog() {
  localStorage.removeItem(FOG_STORAGE_KEY);
  localStorage.removeItem('vetuu_fog'); // Clear old format too
}

// ============================================
// DISCOVERY XP
// ============================================
const discoveredPOIs = new Set();

export async function checkPOIDiscovery(state, x, y) {
  const offset = state.map.meta.originalOffset || { x: 0, y: 0 };
  
  for (const region of state.map.regions || []) {
    if (discoveredPOIs.has(region.id)) continue;

    // Translate bounds for expanded map
    const b = {
      x0: region.bounds.x0 + offset.x,
      y0: region.bounds.y0 + offset.y,
      x1: region.bounds.x1 + offset.x,
      y1: region.bounds.y1 + offset.y
    };
    
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      discoveredPOIs.add(region.id);

      // Grant discovery XP
      const { grantXP, showToast } = await import('./game.js');
      showToast(`Discovered: ${region.name}`, 'quest');
      grantXP(50);

      return region;
    }
  }

  return null;
}


