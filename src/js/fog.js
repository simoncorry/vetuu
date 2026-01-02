/**
 * VETUU — Fog of War Module
 * Canvas-based fog rendering for performance on large maps
 */

const REVEAL_RADIUS = 8;
const FOG_STORAGE_KEY = 'vetuu_fog_v2';

let fogCanvas = null;
let fogCtx = null;
let fogMask = null; // 2D array: true = revealed
let mapWidth = 0;
let mapHeight = 0;
let tileSize = 24;

// ============================================
// INITIALIZATION
// ============================================
export function initFog(state) {
  const fogLayer = document.getElementById('fog-layer');
  
  mapWidth = state.map.meta.width;
  mapHeight = state.map.meta.height;
  tileSize = state.map.meta.tileSize;

  // Create canvas for fog
  fogCanvas = document.createElement('canvas');
  fogCanvas.id = 'fog-canvas';
  fogCanvas.width = mapWidth * tileSize;
  fogCanvas.height = mapHeight * tileSize;
  fogCanvas.style.cssText = 'position: absolute; top: 0; left: 0; pointer-events: none;';
  
  fogLayer.innerHTML = '';
  fogLayer.appendChild(fogCanvas);
  
  fogCtx = fogCanvas.getContext('2d');

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

  // Initial render
  renderFog(state);
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
  el.style.left = `${x * tileSize}px`;
  el.style.top = `${y * tileSize}px`;
  
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
  
  // Remove after animation completes (350ms)
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

export function revealAround(state, centerX, centerY, radius = REVEAL_RADIUS) {
  // Ensure runtime.revealedTiles exists
  if (!state.runtime.revealedTiles) {
    state.runtime.revealedTiles = new Set();
  }

  // Expand scan area to include dither margin
  const ditherMargin = 3;
  const scanStartX = Math.max(0, centerX - radius - ditherMargin);
  const scanStartY = Math.max(0, centerY - radius - ditherMargin);
  const scanEndX = Math.min(mapWidth, centerX + radius + 1 + ditherMargin);
  const scanEndY = Math.min(mapHeight, centerY + radius + 1 + ditherMargin);
  
  // 1. Capture BEFORE states for all tiles in affected area
  const beforeStates = new Map();
  for (let y = scanStartY; y < scanEndY; y++) {
    for (let x = scanStartX; x < scanEndX; x++) {
      beforeStates.set(`${x},${y}`, getTileState(x, y));
    }
  }
  
  // 2. Update fogMask with newly revealed tiles
  let changed = false;
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
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveFogMask();
    
    // 3. Create fade elements for tiles whose state changed
    for (let y = scanStartY; y < scanEndY; y++) {
      for (let x = scanStartX; x < scanEndX; x++) {
        const key = `${x},${y}`;
        const beforeState = beforeStates.get(key);
        const afterState = getTileState(x, y);
        
        if (beforeState !== afterState) {
          createFogFadeElement(x, y, beforeState, afterState);
        }
      }
    }
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
// FOG RENDERING (Canvas-based)
// ============================================

/**
 * Get the distance from a fogged tile to the nearest revealed tile.
 * Returns 0 if revealed, Infinity if no revealed neighbors within range.
 */
function getDistanceToRevealed(x, y, maxDist = 2) {
  if (fogMask[y]?.[x]) return 0; // Already revealed
  
  // Check in expanding rings
  for (let dist = 1; dist <= maxDist; dist++) {
    for (let dy = -dist; dy <= dist; dy++) {
      for (let dx = -dist; dx <= dist; dx++) {
        // Only check tiles at exactly this distance (Chebyshev)
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== dist) continue;
        
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < mapWidth && ny < mapHeight) {
          if (fogMask[ny][nx]) return dist;
        }
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
 * Draw a dithered fog tile using pixel-level Bayer dithering.
 * Threshold determines how many pixels are drawn (0-16 scale).
 */
function drawDitheredTile(x, y, threshold) {
  const px = x * tileSize;
  const py = y * tileSize;
  
  // Calculate how many "dither cells" fit in a tile (6 cells = 4px each for 24px tile)
  const cellSize = 4;
  const cells = tileSize / cellSize;
  
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const bayerValue = BAYER_4X4[cy % 4][cx % 4];
      if (bayerValue < threshold) {
        fogCtx.fillRect(
          px + cx * cellSize,
          py + cy * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }
}

export function renderFog(_state) {
  if (!fogCtx || !fogMask) return;

  // Clear canvas
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  
  // Fog color
  fogCtx.fillStyle = 'rgba(10, 12, 14, 0.95)';
  
  // Render unrevealed tiles with dithering at edges
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      if (!fogMask[y][x]) {
        const distToRevealed = getDistanceToRevealed(x, y, 2);
        
        if (distToRevealed === 1) {
          // Innermost fog ring - sparse dither (8/16 pixels)
          drawDitheredTile(x, y, 8);
        } else if (distToRevealed === 2) {
          // Second ring - denser dither (12/16 pixels)
          drawDitheredTile(x, y, 12);
        } else {
          // Full fog for all other tiles
          fogCtx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
      }
    }
  }
}

// Optimized: only redraw affected area
export function updateFogArea(centerX, centerY, radius = REVEAL_RADIUS) {
  if (!fogCtx) return;
  
  // Expand area by 2 tiles to handle dither edge recalculation
  const ditherMargin = 2;
  const startX = Math.max(0, centerX - radius - ditherMargin);
  const startY = Math.max(0, centerY - radius - ditherMargin);
  const endX = Math.min(mapWidth, centerX + radius + 1 + ditherMargin);
  const endY = Math.min(mapHeight, centerY + radius + 1 + ditherMargin);
  
  // Clear and redraw just this area
  fogCtx.clearRect(
    startX * tileSize, 
    startY * tileSize, 
    (endX - startX) * tileSize, 
    (endY - startY) * tileSize
  );
  
  fogCtx.fillStyle = 'rgba(10, 12, 14, 0.95)';
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      if (!fogMask[y][x]) {
        const distToRevealed = getDistanceToRevealed(x, y, 2);
        
        if (distToRevealed === 1) {
          // Innermost fog ring - sparse dither (8/16 pixels)
          drawDitheredTile(x, y, 8);
        } else if (distToRevealed === 2) {
          // Second ring - denser dither (12/16 pixels)
          drawDitheredTile(x, y, 12);
        } else {
          // Full fog for all other tiles
          fogCtx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
      }
    }
  }
}

// ============================================
// PERSISTENCE
// ============================================
function saveFogMask() {
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
