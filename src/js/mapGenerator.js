/**
 * VETUU — Map Generator
 * Procedurally expands the base map 4x (120x80 → 480x320)
 * Drycross base centered at (240, 168) in expanded map
 */

import { cssVar } from './utils.js';

// Original base center in 120x80 map
const ORIGINAL_BASE_CENTER = { x: 56, y: 38 };

// Expansion dimensions
const EXPANDED_WIDTH = 480;
const EXPANDED_HEIGHT = 320;
const ORIGINAL_WIDTH = 120;
const ORIGINAL_HEIGHT = 80;

// Offset to center original map in expanded map
export const EXPANSION_OFFSET = {
  x: Math.floor((EXPANDED_WIDTH - ORIGINAL_WIDTH) / 2),   // 180
  y: Math.floor((EXPANDED_HEIGHT - ORIGINAL_HEIGHT) / 2)  // 120
};

// Base center in expanded coordinates (56+180, 38+120) = (236, 158)
export const BASE_CENTER = { 
  x: ORIGINAL_BASE_CENTER.x + EXPANSION_OFFSET.x,  // 236
  y: ORIGINAL_BASE_CENTER.y + EXPANSION_OFFSET.y   // 158
};

// Road dimensions (used for object filtering and terrain generation)
const ROAD_MAIN_HALF = 1;      // Main road is 3 tiles wide (center ± 1)
const ROAD_TOTAL_HALF = 3;     // Total footprint is 7 tiles wide (center ± 3)

// Terrain types for procedural generation
// '1' (dune) is lightest and most common, '0' and '8' are accent variations
const TERRAIN = {
  DESERT: ['1', '1', '1', '0', '8'], // 60% dune, 20% sand, 20% drySand
  ROCK: ['2'],
  ASH: ['6'],
  SALT: ['7']
};

/**
 * Expand the map data 4x
 */
export function expandMap(originalMap) {
  const newWidth = 480;
  const newHeight = 320;
  
  // Calculate offset to place original map in center
  const offsetX = Math.floor((newWidth - originalMap.meta.width) / 2);
  const offsetY = Math.floor((newHeight - originalMap.meta.height) / 2);

  // Generate expanded ground
  const expandedGround = [];
  for (let y = 0; y < newHeight; y++) {
    let row = '';
    for (let x = 0; x < newWidth; x++) {
      // Check if within original map bounds
      const origX = x - offsetX;
      const origY = y - offsetY;
      
      if (origX >= 0 && origX < originalMap.meta.width && 
          origY >= 0 && origY < originalMap.meta.height) {
        // Use original tile, but apply road weathering if it's a road
        let tile = originalMap.ground[origY][origX];
        
        // Check if this position is on a main road axis (even inside base)
        const onVerticalRoad = Math.abs(x - BASE_CENTER.x) <= ROAD_MAIN_HALF;
        const onHorizontalRoad = Math.abs(y - BASE_CENTER.y) <= ROAD_MAIN_HALF;
        const onMainRoadAxis = onVerticalRoad || onHorizontalRoad;
        
        // Apply weathering to road tiles OR to tiles on road axis (including market)
        if (tile === '3' || tile === 'e' || tile === 'f' || 
            (onMainRoadAxis && (tile === 'd' || tile === '4'))) {
          const weatheredTile = applyRoadWeathering(x, y);
          if (weatheredTile !== null) {
            tile = weatheredTile;
          }
          // null means missing tile - use sand (walkable terrain)
          else {
            tile = '1';
          }
        }
        row += tile;
      } else {
        // Generate procedural terrain based on distance from center
        row += generateTerrain(x, y, newWidth, newHeight);
      }
    }
    expandedGround.push(row);
  }

  // Expand objects with new positions, filtering out those on road footprint
  const expandedObjects = originalMap.objects
    .map(obj => ({
      ...obj,
      x: obj.x + offsetX,
      y: obj.y + offsetY
    }))
    .filter(obj => {
      // Keep objects that are NOT on the road footprint
      const onVerticalRoad = Math.abs(obj.x - BASE_CENTER.x) <= ROAD_TOTAL_HALF;
      const onHorizontalRoad = Math.abs(obj.y - BASE_CENTER.y) <= ROAD_TOTAL_HALF;
      return !onVerticalRoad && !onHorizontalRoad;
    });

  // Add border walls/cliffs
  const borderObjects = generateBorderObjects(newWidth, newHeight);
  expandedObjects.push(...borderObjects);

  // Add scattered terrain features
  const scatteredObjects = generateScatteredFeatures(newWidth, newHeight, offsetX, offsetY);
  expandedObjects.push(...scatteredObjects);

  // Add lamp posts along roads
  const lampPosts = generateRoadLampPosts(newWidth, newHeight, offsetX, offsetY);
  expandedObjects.push(...lampPosts);

  return {
    meta: {
      ...originalMap.meta,
      width: newWidth,
      height: newHeight,
      expanded: true,
      originalOffset: { x: offsetX, y: offsetY }
    },
    legend: originalMap.legend,
    ground: expandedGround,
    objects: expandedObjects
  };
}

// Road tile types (must match legend in map.json)
const ROAD_TILES = {
  normal: '3',
  worn: 'e',
  cracked: 'f'
};

/**
 * Apply weathering to an existing road tile
 * Returns the weathered tile, or null if the tile should be removed (show terrain)
 */
function applyRoadWeathering(x, y) {
  const rand = seededRandom(x * 1000 + y);
  const rand2 = seededRandom(x * 7777 + y * 3333);
  
  // Check if on debris zone (outer tiles of road footprint)
  const distToVertical = Math.abs(x - BASE_CENTER.x);
  const distToHorizontal = Math.abs(y - BASE_CENTER.y);
  const onMainVertical = distToVertical <= ROAD_MAIN_HALF;
  const onMainHorizontal = distToHorizontal <= ROAD_MAIN_HALF;
  const onMainRoad = onMainVertical || onMainHorizontal;
  
  if (onMainRoad) {
    // Main road - 12% missing, 5% worn, 3% cracked (80% normal)
    if (rand < 0.12) {
      return null;  // Missing - show terrain
    } else if (rand < 0.17) {
      return ROAD_TILES.worn;
    } else if (rand < 0.20) {
      return ROAD_TILES.cracked;
    }
    return ROAD_TILES.normal;
  } else {
    // Debris zone - 75% missing, 25% debris chunks (reduced)
    if (rand < 0.75) {
      return null;  // Show terrain
    }
    return rand2 < 0.5 ? ROAD_TILES.cracked : ROAD_TILES.worn;
  }
}

/**
 * Check if position is on a road and return appropriate road tile
 * Roads run N-S and E-W through base center
 * - Inner 3 tiles: main road surface with weathering
 * - Outer 2 tiles each side: debris zone (mostly empty with scattered road chunks)
 */
function getRoadTile(x, y, centerX, centerY) {
  const distToVertical = Math.abs(x - centerX);
  const distToHorizontal = Math.abs(y - centerY);
  
  const onVerticalRoad = distToVertical <= ROAD_TOTAL_HALF;
  const onHorizontalRoad = distToHorizontal <= ROAD_TOTAL_HALF;
  
  if (!onVerticalRoad && !onHorizontalRoad) {
    return null;
  }
  
  // Determine if we're on main road or debris zone
  const onMainVertical = distToVertical <= ROAD_MAIN_HALF;
  const onMainHorizontal = distToHorizontal <= ROAD_MAIN_HALF;
  const onMainRoad = onMainVertical || onMainHorizontal;
  
  const rand = seededRandom(x * 1000 + y);
  const rand2 = seededRandom(x * 7777 + y * 3333);
  
  if (onMainRoad) {
    // Main road surface - 12% missing, 5% worn, 3% cracked (80% normal)
    if (rand < 0.12) {
      // Missing - world bg shows through
      return null;
    } else if (rand < 0.17) {
      return ROAD_TILES.worn;
    } else if (rand < 0.20) {
      return ROAD_TILES.cracked;
    }
    return ROAD_TILES.normal;
  } else {
    // Debris zone - 75% empty, 25% debris chunks
    if (rand < 0.75) {
      // Show world terrain
      return null;
    }
    return rand2 < 0.5 ? ROAD_TILES.cracked : ROAD_TILES.worn;
  }
}

/**
 * Generate terrain based on position
 */
function generateTerrain(x, y, width, height) {
  // Use actual base center, not geometric map center
  const centerX = BASE_CENTER.x;
  const centerY = BASE_CENTER.y;
  
  // Check if this position is on the road path
  const distToVertical = Math.abs(x - centerX);
  const distToHorizontal = Math.abs(y - centerY);
  const onRoadPath = distToVertical <= ROAD_TOTAL_HALF || distToHorizontal <= ROAD_TOTAL_HALF;
  
  if (onRoadPath) {
    // Get road tile (may be null for "missing" tiles)
    const roadTile = getRoadTile(x, y, centerX, centerY);
    if (roadTile) {
      return roadTile;
    }
    // Missing road tile - use sand (walkable terrain that shows through)
    return '1';
  }
  
  const distFromCenter = Math.hypot(x - centerX, y - centerY);
  const maxDist = Math.hypot(width / 2, height / 2);
  const normalizedDist = distFromCenter / maxDist;

  // Add noise for variety
  const noise = seededRandom(x * 1000 + y);
  const noise2 = seededRandom(x * 7777 + y * 3333);
  
  // Determine quadrant for biome accents
  const inNorth = y < centerY;
  const inWest = x < centerX;
  
  // Sand is ALWAYS the dominant tile (desert world)
  // 75-85% sand everywhere, with biome-specific accents
  
  if (normalizedDist < 0.25) {
    // Inner zone (near base walls): pure desert sand
    return TERRAIN.DESERT[Math.floor(noise * TERRAIN.DESERT.length)];
  }
  
  // Determine accent chance based on distance (more accents further out)
  const accentChance = Math.min(0.25, (normalizedDist - 0.25) * 0.5); // 0% at 0.25, max 25% at edges
  
  // Roll for accent tile
  if (noise < accentChance) {
    // Quadrant-based biome accents
    if (inNorth && inWest) {
      // NW: Ash wastes accent
      return noise2 < 0.7 ? TERRAIN.ASH[0] : TERRAIN.ROCK[0];
    } else if (inNorth && !inWest) {
      // NE: Rocky desert accent
      return noise2 < 0.6 ? TERRAIN.ROCK[0] : TERRAIN.ASH[0];
    } else if (!inNorth && inWest) {
      // SW: Salt flats accent  
      return noise2 < 0.7 ? TERRAIN.SALT[0] : TERRAIN.ASH[0];
    } else {
      // SE: Mixed wastes accent
      if (noise2 < 0.4) return TERRAIN.ASH[0];
      if (noise2 < 0.7) return TERRAIN.SALT[0];
      return TERRAIN.ROCK[0];
    }
  }
  
  // Default: sand (75-85% of tiles)
  return TERRAIN.DESERT[Math.floor(noise2 * TERRAIN.DESERT.length)];
}

/**
 * Generate border blocking objects
 */
function generateBorderObjects(width, height) {
  const objects = [];
  const borderWidth = 3;
  let id = 10000;

  // Create impassable border
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < borderWidth; y++) {
      objects.push({ id: `border_${id++}`, type: 'act3_blocker', x, y: y, solid: true });
      objects.push({ id: `border_${id++}`, type: 'act3_blocker', x, y: height - 1 - y, solid: true });
    }
  }
  for (let y = borderWidth; y < height - borderWidth; y++) {
    for (let x = 0; x < borderWidth; x++) {
      objects.push({ id: `border_${id++}`, type: 'act3_blocker', x: x, y, solid: true });
      objects.push({ id: `border_${id++}`, type: 'act3_blocker', x: width - 1 - x, y, solid: true });
    }
  }

  return objects;
}

/**
 * Generate scattered terrain features (rocks, wrecks, etc.)
 */
function generateScatteredFeatures(width, height, offsetX, offsetY) {
  const objects = [];
  let id = 20000;

  // Use actual base center for distance calculations
  const centerX = BASE_CENTER.x;
  const centerY = BASE_CENTER.y;

  // Scatter rocks and wrecks in the expanded areas
  for (let i = 0; i < 200; i++) {
    const x = Math.floor(seededRandom(i * 7) * width);
    const y = Math.floor(seededRandom(i * 13) * height);
    
    // Skip if in original map area or too close to base center
    const distFromCenter = Math.hypot(x - centerX, y - centerY);
    if (distFromCenter < 50) continue;
    if (x >= offsetX && x < offsetX + ORIGINAL_WIDTH && y >= offsetY && y < offsetY + ORIGINAL_HEIGHT) continue;
    
    // Skip if on road footprint (7 tiles wide = 3 from center + buffer)
    if (Math.abs(x - centerX) <= ROAD_TOTAL_HALF + 2 || Math.abs(y - centerY) <= ROAD_TOTAL_HALF + 2) continue;

    const type = seededRandom(i * 31) < 0.6 ? 'junk' : 'wreck';
    objects.push({ id: `scatter_${id++}`, type, x, y, solid: true });
  }

  // Add some resource nodes in outer areas
  for (let i = 0; i < 50; i++) {
    const x = Math.floor(seededRandom(i * 17 + 1000) * width);
    const y = Math.floor(seededRandom(i * 23 + 1000) * height);
    
    const distFromCenter = Math.hypot(x - centerX, y - centerY);
    if (distFromCenter < 60) continue;
    if (x < 5 || x > width - 5 || y < 5 || y > height - 5) continue;
    
    // Skip if on road footprint
    if (Math.abs(x - centerX) <= ROAD_TOTAL_HALF + 2 || Math.abs(y - centerY) <= ROAD_TOTAL_HALF + 2) continue;

    const type = seededRandom(i * 41) < 0.5 ? 'scrapNode' : 'clothNode';
    objects.push({ 
      id: `node_${id++}`, 
      type, 
      x, 
      y, 
      solid: false,
      interact: type === 'scrapNode' ? 'gatherScrap' : 'gatherCloth'
    });
  }

  return objects;
}

/**
 * Generate lamp posts along roads at random intervals
 * Lamps are placed on the outermost tiles of the road footprint (±3 from center)
 * Lamps alternate sides: left, right, left, right...
 */
function generateRoadLampPosts(width, height, offsetX, offsetY) {
  const objects = [];
  let id = 30000;
  
  const centerX = BASE_CENTER.x;
  const centerY = BASE_CENTER.y;
  const lampOffset = ROAD_TOTAL_HALF; // Place on outermost tile (3 tiles from center)
  
  // Average spacing between lamps (tiles)
  const LAMP_SPACING_MIN = 12;
  const LAMP_SPACING_MAX = 20;
  
  // Skip areas
  const borderBuffer = 10;
  const baseBuffer = 4; // Place lamps right up to base walls
  
  // Base bounds in expanded coordinates
  const baseMinY = offsetY + 19;  // Original base y bounds
  const baseMaxY = offsetY + 57;
  const baseMinX = offsetX + 31;  // Original base x bounds
  const baseMaxX = offsetX + 81;
  
  // Vertical road (N-S) - alternate between left and right sides
  let nextLampY = borderBuffer;
  let verticalSide = -1; // Start on left side (-1 = left, +1 = right)
  
  while (nextLampY < height - borderBuffer) {
    // Skip if inside base area (with buffer)
    const inBaseArea = nextLampY >= baseMinY - baseBuffer && nextLampY <= baseMaxY + baseBuffer;
    
    if (!inBaseArea) {
      objects.push({
        id: `lamp_road_${id++}`,
        type: 'lamp',
        x: centerX + (lampOffset * verticalSide),
        y: nextLampY,
        solid: true,
        light: { radius: 8, color: cssVar('--light-lamp'), intensity: 0.9 }
      });
      
      // Alternate side for next lamp
      verticalSide *= -1;
    }
    
    // Random spacing to next lamp
    const spacing = LAMP_SPACING_MIN + Math.floor(seededRandom(nextLampY * 123) * (LAMP_SPACING_MAX - LAMP_SPACING_MIN));
    nextLampY += spacing;
  }
  
  // Horizontal road (E-W) - alternate between top and bottom sides
  let nextLampX = borderBuffer;
  let horizontalSide = -1; // Start on top side (-1 = top, +1 = bottom)
  
  while (nextLampX < width - borderBuffer) {
    // Skip if inside base area (with buffer)
    const inBaseArea = nextLampX >= baseMinX - baseBuffer && nextLampX <= baseMaxX + baseBuffer;
    
    if (!inBaseArea) {
      objects.push({
        id: `lamp_road_${id++}`,
        type: 'lamp',
        x: nextLampX,
        y: centerY + (lampOffset * horizontalSide),
        solid: true,
        light: { radius: 8, color: cssVar('--light-lamp'), intensity: 0.9 }
      });
      
      // Alternate side for next lamp
      horizontalSide *= -1;
    }
    
    // Random spacing to next lamp
    const spacing = LAMP_SPACING_MIN + Math.floor(seededRandom(nextLampX * 321) * (LAMP_SPACING_MAX - LAMP_SPACING_MIN));
    nextLampX += spacing;
  }
  
  return objects;
}

/**
 * Simple seeded random for deterministic generation
 */
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Convert original coordinates to expanded coordinates
 */
export function toExpandedCoords(origX, origY) {
  // Offset to center the original map
  const offsetX = Math.floor((480 - 120) / 2);
  const offsetY = Math.floor((320 - 80) / 2);
  return { x: origX + offsetX, y: origY + offsetY };
}

/**
 * Convert expanded coordinates to original (if within bounds)
 */
export function toOriginalCoords(expX, expY) {
  const offsetX = Math.floor((480 - 120) / 2);
  const offsetY = Math.floor((320 - 80) / 2);
  return { x: expX - offsetX, y: expY - offsetY };
}

