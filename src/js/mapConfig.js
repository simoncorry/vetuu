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
  originalWidth: 200,
  originalHeight: 140,
  
  // Expanded map dimensions (after mapGenerator expansion)
  width: 480,
  height: 320,
  
  // Target expansion dimensions (what we expand TO)
  expandedWidth: 480,
  expandedHeight: 320,
  
  // Offset where original map is placed within expanded map
  offset: { x: 140, y: 90 },
  
  // Base center (Drycross) in expanded coordinates
  // Calculated as: originalBaseCenter + offset
  baseCenter: { x: 196, y: 128 },
  
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
  
  // Target expansion dimensions (can be overridden for story expansions)
  mapConfig.expandedWidth = options.expandedWidth ?? 480;
  mapConfig.expandedHeight = options.expandedHeight ?? 320;
  
  // Calculate offset to center original map in expanded map
  mapConfig.offset = {
    x: Math.floor((mapConfig.expandedWidth - mapConfig.originalWidth) / 2),
    y: Math.floor((mapConfig.expandedHeight - mapConfig.originalHeight) / 2)
  };
  
  // Final map dimensions (after expansion)
  mapConfig.width = mapConfig.expandedWidth;
  mapConfig.height = mapConfig.expandedHeight;
  
  // Original base center (from map data or default)
  mapConfig.originalBaseCenter = options.baseCenter ?? { x: 56, y: 38 };
  
  // Calculate base center in expanded coordinates
  mapConfig.baseCenter = {
    x: mapConfig.originalBaseCenter.x + mapConfig.offset.x,
    y: mapConfig.originalBaseCenter.y + mapConfig.offset.y
  };
  
  // Update ring boundaries based on available space
  updateRingBoundaries();
  
  mapConfig.initialized = true;
  
  console.log('[MapConfig] Initialized:');
  console.log('  Original:', mapConfig.originalWidth, 'x', mapConfig.originalHeight);
  console.log('  Expanded:', mapConfig.width, 'x', mapConfig.height);
  console.log('  Offset:', mapConfig.offset.x, mapConfig.offset.y);
  console.log('  Base center:', mapConfig.baseCenter.x, mapConfig.baseCenter.y);
  
  return mapConfig;
}

/**
 * Update map config after expansion (called by mapGenerator).
 * This confirms the actual dimensions after expansion is complete.
 * 
 * @param {object} expandedMapMeta - The meta from the expanded map
 */
export function confirmExpansion(expandedMapMeta) {
  mapConfig.width = expandedMapMeta.width;
  mapConfig.height = expandedMapMeta.height;
  
  if (expandedMapMeta.originalOffset) {
    mapConfig.offset = { ...expandedMapMeta.originalOffset };
    
    // Recalculate base center with confirmed offset
    mapConfig.baseCenter = {
      x: mapConfig.originalBaseCenter.x + mapConfig.offset.x,
      y: mapConfig.originalBaseCenter.y + mapConfig.offset.y
    };
  }
  
  console.log('[MapConfig] Expansion confirmed:', mapConfig.width, 'x', mapConfig.height);
}

// ============================================
// RING BOUNDARY CALCULATION
// ============================================

/**
 * Update ring boundaries based on current map dimensions.
 * Rings are scaled to fit within the available space.
 */
function updateRingBoundaries() {
  // Calculate max safe distance from base to any edge
  const maxLeft = mapConfig.baseCenter.x;
  const maxRight = mapConfig.width - mapConfig.baseCenter.x;
  const maxTop = mapConfig.baseCenter.y;
  const maxBottom = mapConfig.height - mapConfig.baseCenter.y;
  const maxReach = Math.min(maxLeft, maxRight, maxTop, maxBottom);
  
  // Scale rings to fit within max reach
  // Default rings assume max reach of ~128 tiles (480x320 map)
  const scale = maxReach / 128;
  
  mapConfig.rings = {
    safe:       { min: 0,                          max: Math.round(28 * scale) },
    frontier:   { min: Math.round(29 * scale),     max: Math.round(55 * scale) },
    wilderness: { min: Math.round(56 * scale),     max: Math.round(85 * scale) },
    danger:     { min: Math.round(86 * scale),     max: Math.round(110 * scale) },
    deep:       { min: Math.round(111 * scale),    max: Infinity }
  };
  
  console.log('[MapConfig] Ring boundaries updated (maxReach:', Math.round(maxReach), ')');
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
  const { rings, ringColors } = mapConfig;
  return [
    { name: 'SAFE', max: rings.safe.max, color: ringColors.safe },
    { name: 'FRONTIER', max: rings.frontier.max, color: ringColors.frontier },
    { name: 'WILDERNESS', max: rings.wilderness.max, color: ringColors.wilderness },
    { name: 'DANGER', max: rings.danger.max, color: ringColors.danger },
    { name: 'DEEP', max: Math.min(rings.deep.min + 20, 150), color: ringColors.deep }
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

