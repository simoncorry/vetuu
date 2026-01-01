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
export function revealAround(state, centerX, centerY, radius = REVEAL_RADIUS) {
  let changed = false;

  // Ensure runtime.revealedTiles exists
  if (!state.runtime.revealedTiles) {
    state.runtime.revealedTiles = new Set();
  }

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
export function renderFog(state) {
  if (!fogCtx || !fogMask) return;

  // Clear canvas
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  
  // Draw fog (black with alpha)
  fogCtx.fillStyle = 'rgba(10, 12, 14, 0.95)';
  
  // Only draw unrevealed tiles
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      if (!fogMask[y][x]) {
        fogCtx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }
  }
}

// Optimized: only redraw affected area
export function updateFogArea(centerX, centerY, radius = REVEAL_RADIUS) {
  if (!fogCtx) return;
  
  const startX = Math.max(0, centerX - radius);
  const startY = Math.max(0, centerY - radius);
  const endX = Math.min(mapWidth, centerX + radius + 1);
  const endY = Math.min(mapHeight, centerY + radius + 1);
  
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
        fogCtx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
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
