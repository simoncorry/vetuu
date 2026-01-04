/**
 * VETUU — Map Configuration
 * 
 * Centralized source of truth for all map-related dimensions and coordinates.
 * This module should be imported by any code that needs to know about:
 * - Map dimensions (original and expanded)
 * - Base center location (Drycross)
 * - Expansion offsets
 * - Ring boundaries for spawn zones
 * 
 * Usage:
 *   import { mapConfig, initMapConfig } from './mapConfig.js';
 *   
 *   // At game start (after loading map data):
 *   initMapConfig(mapData);
 *   
 *   // Anywhere else:
 *   const center = mapConfig.baseCenter;
 *   const rings = mapConfig.rings;
 */

// ============================================
// CONFIGURATION STATE
// ============================================

/**
 * The main configuration object.
 * All values are set by initMapConfig() based on actual loaded map data.
 */
export const mapConfig = {
  // Original map dimensions (from map.json, before expansion)
  originalWidth: 136,
  originalHeight: 136,
  
  // Expanded map dimensions (after mapGenerator expansion)
  // Default to 400x400 square - actual values set by initMapConfig
  width: 400,
  height: 400,
  
  // Target expansion dimensions (what we expand TO)
  expandedWidth: 400,
  expandedHeight: 400,
  
  // Offset where original map is placed within expanded map
  // Calculated to center the BASE at (200, 200)
  // With originalBaseCenter at (68, 68): offset = (200-68, 200-68) = (132, 132)
  offset: { x: 132, y: 132 },
  
  // Base center (Drycross) in expanded coordinates
  // For 400x400 square map, base is at exact center
  baseCenter: { x: 200, y: 200 },
  
  // Original base center in the source map coordinate system
  // This is where Drycross is in the map.json data
  originalBaseCenter: { x: 56, y: 38 },
  
  // Ring boundaries for spawn zones (in tiles from baseCenter)
  rings: {
    safe:       { min: 0,   max: 28 },
    frontier:   { min: 29,  max: 55 },
    wilderness: { min: 56,  max: 85 },
    danger:     { min: 86,  max: 110 },
    deep:       { min: 111, max: Infinity }
  },
  
  // Ring colors for debug visualization
  ringColors: {
    safe:       '#00ff00',  // Green
    frontier:   '#ffff00',  // Yellow
    wilderness: '#ff8800',  // Orange
    danger:     '#ff0000',  // Red
    deep:       '#ff00ff'   // Magenta
  },
  
  // Whether map has been initialized
  initialized: false
};

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize map configuration from loaded map data.
 * Call this once after loading map.json but BEFORE expansion.
 * 
 * @param {object} originalMapData - The raw map data from map.json
 * @param {object} options - Optional overrides
 */
export function initMapConfig(originalMapData, options = {}) {
  const meta = originalMapData.meta;
  
  // Store original dimensions
  mapConfig.originalWidth = meta.width;
  mapConfig.originalHeight = meta.height;
  
  // Original base center (Drycross) in the original coordinate system
  // Based on actual wall positions: x 43-93 (center 68), y 49-87 (center 68)
  // Map was cropped to 136x136 centered on base
  mapConfig.originalBaseCenter = options.baseCenter ?? { x: 68, y: 68 };
  
  // Target expansion dimensions - use a SQUARE map for symmetrical rings
  // Default 400x400 gives base at perfect center (200, 200)
  const targetSize = options.expandedSize ?? 400;
  mapConfig.expandedWidth = options.expandedWidth ?? targetSize;
  mapConfig.expandedHeight = options.expandedHeight ?? targetSize;
  
  // Calculate offset to CENTER THE BASE (not the original map)
  // This ensures the base is at the center of the expanded map
  mapConfig.offset = {
    x: Math.floor(mapConfig.expandedWidth / 2) - mapConfig.originalBaseCenter.x,
    y: Math.floor(mapConfig.expandedHeight / 2) - mapConfig.originalBaseCenter.y
  };
  
  // Final map dimensions (after expansion)
  mapConfig.width = mapConfig.expandedWidth;
  mapConfig.height = mapConfig.expandedHeight;
  
  // Base center is now at the center of the expanded map
  mapConfig.baseCenter = {
    x: Math.floor(mapConfig.expandedWidth / 2),
    y: Math.floor(mapConfig.expandedHeight / 2)
  };
  
  // Update ring boundaries based on available space
  updateRingBoundaries();
  
  mapConfig.initialized = true;
  
  console.log('[MapConfig] Initialized:');
  console.log('  Original map:', mapConfig.originalWidth, 'x', mapConfig.originalHeight);
  console.log('  Expanded to:', mapConfig.width, 'x', mapConfig.height);
  console.log('  Offset (to center base):', mapConfig.offset.x, mapConfig.offset.y);
  console.log('  Original base center:', mapConfig.originalBaseCenter.x, mapConfig.originalBaseCenter.y);
  console.log('  NEW base center:', mapConfig.baseCenter.x, mapConfig.baseCenter.y);
  console.log('  Verification: original base', mapConfig.originalBaseCenter.x, '+', mapConfig.offset.x, '=', mapConfig.originalBaseCenter.x + mapConfig.offset.x);
  
  return mapConfig;
}

/**
 * Update map config after expansion (called by mapGenerator).
 * This confirms the actual dimensions after expansion is complete.
 * 
 * NOTE: We do NOT recalculate baseCenter here - it was already set
 * correctly in initMapConfig to be at the center of the map.
 * 
 * @param {object} expandedMapMeta - The meta from the expanded map
 */
export function confirmExpansion(expandedMapMeta) {
  mapConfig.width = expandedMapMeta.width;
  mapConfig.height = expandedMapMeta.height;
  
  // baseCenter is already correctly set to map center in initMapConfig
  // Don't override it with offset-based calculation
  
  console.log('[MapConfig] Expansion confirmed:', mapConfig.width, 'x', mapConfig.height);
  console.log('[MapConfig] Base center remains at:', mapConfig.baseCenter.x, mapConfig.baseCenter.y);
}

// ============================================
// RING BOUNDARY CALCULATION
// ============================================

/**
 * Update ring boundaries based on current map dimensions.
 * For a square map with centered base, rings scale to cover the map evenly.
 */
function updateRingBoundaries() {
  // For a square map with centered base, max reach is the same in all directions
  const maxReach = Math.min(
    mapConfig.baseCenter.x,
    mapConfig.width - mapConfig.baseCenter.x,
    mapConfig.baseCenter.y,
    mapConfig.height - mapConfig.baseCenter.y
  );
  
  // Scale rings proportionally to fill the map
  // With base at center of 400x400, maxReach = 200
  // Rings are designed as percentages of max reach:
  // - Safe: 0-15% (close to base)
  // - Frontier: 15-35% (early exploration)
  // - Wilderness: 35-60% (mid-game)
  // - Danger: 60-85% (late-game)
  // - Deep: 85%+ (endgame, map edges)
  
  // Ring boundaries designed to align with original map edge (68 tiles from center)
  // Original map covers: 0-68 tiles (safe + frontier)
  // Procedural terrain: 69+ tiles (wilderness, danger, deep)
  mapConfig.rings = {
    safe:       { min: 0,   max: 30 },                    // Close to base
    frontier:   { min: 31,  max: 68 },                    // Original map edge
    wilderness: { min: 69,  max: Math.round(maxReach * 0.60) },  // Procedural zone
    danger:     { min: Math.round(maxReach * 0.60) + 1, max: Math.round(maxReach * 0.85) },
    deep:       { min: Math.round(maxReach * 0.85) + 1, max: Infinity }
  };
  
  console.log('[MapConfig] Ring boundaries updated (maxReach:', maxReach, 'tiles)');
  console.log('[MapConfig] Rings:', JSON.stringify(mapConfig.rings));
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Get the ring name for a given distance from base center.
 * @param {number} distance - Distance in tiles from base center
 * @returns {string} Ring name ('safe', 'frontier', 'wilderness', 'danger', 'deep')
 */
export function getRingForDistance(distance) {
  const { rings } = mapConfig;
  
  if (distance <= rings.safe.max) return 'safe';
  if (distance <= rings.frontier.max) return 'frontier';
  if (distance <= rings.wilderness.max) return 'wilderness';
  if (distance <= rings.danger.max) return 'danger';
  return 'deep';
}

/**
 * Calculate distance from base center to a point.
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {number} Distance in tiles
 */
export function distanceFromBase(x, y) {
  const dx = x - mapConfig.baseCenter.x;
  const dy = y - mapConfig.baseCenter.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Check if a point is within map bounds.
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {boolean}
 */
export function isInBounds(x, y) {
  return x >= 0 && x < mapConfig.width && y >= 0 && y < mapConfig.height;
}

/**
 * Clamp a position to map bounds with optional margin.
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} margin - Margin from edge (default 0)
 * @returns {{x: number, y: number}}
 */
export function clampToMap(x, y, margin = 0) {
  return {
    x: Math.max(margin, Math.min(mapConfig.width - 1 - margin, x)),
    y: Math.max(margin, Math.min(mapConfig.height - 1 - margin, y))
  };
}

/**
 * Get ring visualization data for debug overlays.
 * @returns {Array<{name: string, max: number, color: string}>}
 */
export function getRingVisualization() {
  const { rings, ringColors, baseCenter, width, height } = mapConfig;
  
  // Calculate max reach for drawing the deep ring boundary
  const maxReach = Math.min(baseCenter.x, width - baseCenter.x, baseCenter.y, height - baseCenter.y);
  
  return [
    { name: 'SAFE', max: rings.safe.max, color: ringColors.safe },
    { name: 'FRONTIER', max: rings.frontier.max, color: ringColors.frontier },
    { name: 'WILDERNESS', max: rings.wilderness.max, color: ringColors.wilderness },
    { name: 'DANGER', max: rings.danger.max, color: ringColors.danger },
    { name: 'DEEP', max: maxReach, color: ringColors.deep }  // Draw to map edge
  ];
}

// ============================================
// DEBUG
// ============================================

/**
 * Debug: Log current map configuration
 */
export function debugMapConfig() {
  console.log('=== MAP CONFIG ===');
  console.log('Original dimensions:', mapConfig.originalWidth, 'x', mapConfig.originalHeight);
  console.log('Expanded dimensions:', mapConfig.width, 'x', mapConfig.height);
  console.log('Expansion offset:', mapConfig.offset);
  console.log('Base center:', mapConfig.baseCenter);
  console.log('Rings:', mapConfig.rings);
  console.log('Initialized:', mapConfig.initialized);
  return mapConfig;
}

// Expose to console for debugging
if (typeof window !== 'undefined') {
  window.VETUU_MAP_CONFIG = debugMapConfig;
}

