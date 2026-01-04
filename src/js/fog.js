/**
 * VETUU — Fog of War Module
 * Viewport-based canvas rendering for performance on large maps
 * 
 * Instead of an 11,520×7,680 canvas (88M pixels), we use a viewport-sized
 * canvas (~1500×1100 pixels) that repositions with the camera.
 * 
 * PERFORMANCE NOTES:
 * - fogMask[y][x] is the authoritative source for revealed tiles (O(1) lookup)
 * - revealedTiles Set is lazily populated only when minimap needs it
 * - Squared distance comparisons avoid Math.sqrt/hypot in hot loops
 * - Pre-rendered dither stamps eliminate per-tile pixel work
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

  // Initialize revealed tiles set (lazily populated - minimap uses isRevealed() directly)
  // We still maintain this for compatibility but don't populate it upfront
  state.runtime.revealedTiles = new Set();

  // Load saved fog or create new
  const saved = loadFogMask();
  if (saved && saved.length === mapHeight && saved[0]?.length === mapWidth) {
    fogMask = saved;
    // NOTE: We no longer populate revealedTiles here - it was 150k+ string allocations
    // The minimap should use isRevealed(x, y) instead of the Set
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
  
  // Pre-compute squared radii for fast comparisons (avoid sqrt)
  const CORE_RADIUS_SQ = CORE_RADIUS * CORE_RADIUS;
  
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      if (fogMask[y][x]) continue; // Already revealed
      
      // Calculate squared distance from center (avoid sqrt)
      const dx = x - centerX;
      const dy = y - centerY;
      const distSq = dx * dx + dy * dy;
      
      // Inside core radius - always reveal
      if (distSq <= CORE_RADIUS_SQ) {
        fogMask[y][x] = true;
        continue;
      }
      
      // Jagged edge falloff (only compute sqrt for edge tiles)
      const dist = Math.sqrt(distSq);
      const jitter = (seededRandom(x, y) - 0.5) * 2 * JAGGED_AMOUNT;
      const effectiveRadius = CORE_RADIUS + JAGGED_AMOUNT + jitter;
      
      if (dist <= effectiveRadius) {
        const falloffDist = dist - CORE_RADIUS;
        const revealChance = 1 - (falloffDist / (JAGGED_AMOUNT * 2));
        if (seededRandom(x + 100, y + 100) < revealChance) {
          fogMask[y][x] = true;
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

export function revealAround(state, centerX, centerY, radius = REVEAL_RADIUS) {
  // Pre-compute squared radius for fast distance checks
  const radiusSq = radius * radius;
  
  // Quick check: if center tile is already revealed with full radius, skip heavy work
  // This is the common case when walking in already-revealed areas
  // Use squared distance to avoid sqrt in hot loop
  let allRevealed = true;
  for (let dy = -radius; dy <= radius && allRevealed; dy++) {
    for (let dx = -radius; dx <= radius && allRevealed; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x >= 0 && y >= 0 && x < mapWidth && y < mapHeight) {
        const distSq = dx * dx + dy * dy;
        if (distSq <= radiusSq && !fogMask[y][x]) {
          allRevealed = false;
        }
      }
    }
  }
  
  // Early return if nothing to reveal (most common case)
  if (allRevealed) return;
  
  // Update fogMask with newly revealed tiles
  let changed = false;
  
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;

      // Bounds check
      if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight) continue;

      // Circular reveal using squared distance (no sqrt)
      const distSq = dx * dx + dy * dy;
      if (distSq <= radiusSq) {
        if (!fogMask[y][x]) {
          fogMask[y][x] = true;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveFogMask();
    // Fade animation is triggered in updateFogArea() which is called after this
  }
}

export function revealRegion(state, bounds) {
  // Translate bounds if needed (for expanded map)
  const offset = state.map.meta.originalOffset || { x: 0, y: 0 };
  
  // Clamp to map bounds
  const startX = Math.max(0, bounds.x0 + offset.x);
  const startY = Math.max(0, bounds.y0 + offset.y);
  const endX = Math.min(mapWidth - 1, bounds.x1 + offset.x);
  const endY = Math.min(mapHeight - 1, bounds.y1 + offset.y);

  for (let y = startY; y <= endY; y++) {
    const row = fogMask[y];
    for (let x = startX; x <= endX; x++) {
      row[x] = true;
    }
  }

  saveFogMask();
}

export function isRevealed(x, y) {
  if (!fogMask || y < 0 || y >= mapHeight || x < 0 || x >= mapWidth) return false;
  return fogMask[y][x] === true;
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
 * 
 * PERFORMANCE: This is called for every unrevealed tile during render.
 * Optimized with:
 * - Direct array access (no optional chaining in hot path)
 * - Unrolled neighbor checks for distance 1
 * - Early-exit patterns
 */
function getDistanceToRevealed(x, y, maxDist = 2) {
  // Direct array access with bounds already checked by caller
  const row = fogMask[y];
  if (row[x]) return 0; // Already revealed
  
  // Fast path: check immediate 4 cardinal neighbors (most common for dither edge)
  // Use direct access - bounds are implicitly safe due to viewport culling
  const rowAbove = fogMask[y - 1];
  const rowBelow = fogMask[y + 1];
  
  if ((rowAbove && rowAbove[x]) || 
      (rowBelow && rowBelow[x]) || 
      row[x - 1] || row[x + 1]) {
    return 1;
  }
  
  // Check diagonal neighbors for distance 1
  if ((rowAbove && (rowAbove[x - 1] || rowAbove[x + 1])) ||
      (rowBelow && (rowBelow[x - 1] || rowBelow[x + 1]))) {
    return 1;
  }
  
  if (maxDist < 2) return Infinity;
  
  // Check distance 2 ring - unrolled for performance
  // Only check tiles that are exactly distance 2 (Chebyshev distance)
  const row2Above = fogMask[y - 2];
  const row2Below = fogMask[y + 2];
  
  // Top row (y-2)
  if (row2Above && (row2Above[x-2] || row2Above[x-1] || row2Above[x] || row2Above[x+1] || row2Above[x+2])) {
    return 2;
  }
  // Bottom row (y+2)
  if (row2Below && (row2Below[x-2] || row2Below[x-1] || row2Below[x] || row2Below[x+1] || row2Below[x+2])) {
    return 2;
  }
  // Left column (x-2) for middle rows
  if (row[x-2] || (rowAbove && rowAbove[x-2]) || (rowBelow && rowBelow[x-2])) {
    return 2;
  }
  // Right column (x+2) for middle rows
  if (row[x+2] || (rowAbove && rowAbove[x+2]) || (rowBelow && rowBelow[x+2])) {
    return 2;
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
 * 
 * PERFORMANCE: This is the hot path during camera repositioning.
 * - Pre-cached stamp references
 * - Hoisted loop variables
 * - Direct array access
 */
function renderFogViewport() {
  if (!fogCtx || !fogMask) return;
  
  perfStart('fog:renderViewport');

  // Clear canvas
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  
  // Calculate visible tile range (in world coordinates)
  const endX = Math.min(canvasOffsetX + canvasTilesW, mapWidth);
  const endY = Math.min(canvasOffsetY + canvasTilesH, mapHeight);
  
  // Cache stamp references outside loop
  const stampFull = ditherStampFull;
  const stampInner = ditherStampInner;
  const stampOuter = ditherStampOuter;
  const ctx = fogCtx;
  const offsetX = canvasOffsetX;
  const offsetY = canvasOffsetY;
  const tileSize = TILE_SIZE;
  
  // Render unrevealed tiles with dithering at edges (using pre-rendered stamps)
  for (let worldY = canvasOffsetY; worldY < endY; worldY++) {
    const row = fogMask[worldY];
    const canvasY = (worldY - offsetY) * tileSize;
    
    for (let worldX = canvasOffsetX; worldX < endX; worldX++) {
      if (!row[worldX]) {
        // Convert world coords to canvas-local coords
        const canvasX = (worldX - offsetX) * tileSize;
        
        const distToRevealed = getDistanceToRevealed(worldX, worldY, 2);
        
        // Inline stamp selection for performance
        if (distToRevealed === 1) {
          ctx.drawImage(stampInner, canvasX, canvasY);
        } else if (distToRevealed === 2) {
          ctx.drawImage(stampOuter, canvasX, canvasY);
        } else {
          ctx.drawImage(stampFull, canvasX, canvasY);
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
  
  // Cache references outside loop
  const ctx = fogCtx;
  const offsetX = canvasOffsetX;
  const offsetY = canvasOffsetY;
  const tileSize = TILE_SIZE;
  const stampFull = ditherStampFull;
  const stampInner = ditherStampInner;
  const stampOuter = ditherStampOuter;
  
  // Convert to canvas-local coordinates for clearRect
  const clearX = (startX - offsetX) * tileSize;
  const clearY = (startY - offsetY) * tileSize;
  const clearW = (endX - startX) * tileSize;
  const clearH = (endY - startY) * tileSize;
  
  // Clear and redraw just this area (using pre-rendered stamps)
  ctx.clearRect(clearX, clearY, clearW, clearH);
  
  for (let worldY = startY; worldY < endY; worldY++) {
    const row = fogMask[worldY];
    const canvasY = (worldY - offsetY) * tileSize;
    
    for (let worldX = startX; worldX < endX; worldX++) {
      if (!row[worldX]) {
        const canvasX = (worldX - offsetX) * tileSize;
        const distToRevealed = getDistanceToRevealed(worldX, worldY, 2);
        
        // Inline stamp selection for performance
        if (distToRevealed === 1) {
          ctx.drawImage(stampInner, canvasX, canvasY);
        } else if (distToRevealed === 2) {
          ctx.drawImage(stampOuter, canvasX, canvasY);
        } else {
          ctx.drawImage(stampFull, canvasX, canvasY);
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


