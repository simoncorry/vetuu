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
  // Using 128×128 (8×16) for clean multiples of 8
  originalWidth: 128,
  originalHeight: 128,
  
  // Expanded map dimensions (after mapGenerator expansion)
  // Using 512×512 (8×64) for clean multiples of 8
  width: 512,
  height: 512,
  
  // Target expansion dimensions (what we expand TO)
  expandedWidth: 512,
  expandedHeight: 512,
  
  // Offset where original map is placed within expanded map
  // Calculated to center the BASE at (256, 256)
  // With originalBaseCenter at (64, 64): offset = (256-64, 256-64) = (192, 192)
  offset: { x: 192, y: 192 },
  
  // Base center (Drycross) in expanded coordinates
  // For 512×512 square map, base is at exact center
  baseCenter: { x: 256, y: 256 },
  
  // Original base center in the source map coordinate system
  // For 128×128 map, center is at (64, 64)
  originalBaseCenter: { x: 64, y: 64 },
  
  // Ring boundaries for spawn zones (in tiles from baseCenter)
  // All using multiples of 8 for clean alignment
  rings: {
    safe:       { min: 0,   max: 32 },   // 8×4
    frontier:   { min: 33,  max: 64 },   // 8×8 (original map edge)
    wilderness: { min: 65,  max: 128 },  // 8×16
    danger:     { min: 129, max: 192 },  // 8×24
    deep:       { min: 193, max: Infinity } // to 256 (8×32)
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
  // For 128×128 map, center is at (64, 64)
  mapConfig.originalBaseCenter = options.baseCenter ?? { x: 64, y: 64 };
  
  // Target expansion dimensions - use a SQUARE map for symmetrical rings
  // 512×512 (8×64) gives base at perfect center (256, 256)
  const targetSize = options.expandedSize ?? 512;
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
  
  console.log(`[MapConfig] Initialized: ${mapConfig.originalWidth}x${mapConfig.originalHeight} → ${mapConfig.width}x${mapConfig.height}, base at (${mapConfig.baseCenter.x}, ${mapConfig.baseCenter.y})`);
  
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
}

// ============================================
// RING BOUNDARY CALCULATION
// ============================================

/**
 * Update ring boundaries based on current map dimensions.
 * For a square map with centered base, rings scale to cover the map evenly.
 */
function updateRingBoundaries() {
  // All ring boundaries use multiples of 8
  // Original map edge: 64 tiles (128/2)
  // Expanded map edge: 256 tiles (512/2)
  mapConfig.rings = {
    safe:       { min: 0,   max: 32 },     // 8×4 tiles
    frontier:   { min: 33,  max: 64 },     // to 8×8 (original map edge)
    wilderness: { min: 65,  max: 128 },    // to 8×16
    danger:     { min: 129, max: 192 },    // to 8×24
    deep:       { min: 193, max: Infinity } // to 256 (8×32, map edge)
  };
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

