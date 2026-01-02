/**
 * VETUU — Map Generator
 * Procedurally expands the base map 4x (120x80 → 480x320)
 * Drycross base centered at (240, 168) in expanded map
 */

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

// Terrain types for procedural generation
const TERRAIN = {
  DESERT: ['0', '1', '8'], // sand, dune, drySand
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
        // Use original tile
        row += originalMap.ground[origY][origX];
      } else {
        // Generate procedural terrain based on distance from center
        row += generateTerrain(x, y, newWidth, newHeight);
      }
    }
    expandedGround.push(row);
  }

  // Expand objects with new positions
  const expandedObjects = originalMap.objects.map(obj => ({
    ...obj,
    x: obj.x + offsetX,
    y: obj.y + offsetY
  }));

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

// Road dimensions
const ROAD_MAIN_HALF = 1;      // Main road is 3 tiles wide (center ± 1)
const ROAD_TOTAL_HALF = 3;    // Total footprint is 7 tiles wide (center ± 3)

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
    // Main road surface - mostly intact with weathering
    if (rand < 0.08) {
      // 8% completely missing - world bg shows through
      return null;
    } else if (rand < 0.20) {
      return ROAD_TILES.worn;
    } else if (rand < 0.30) {
      return ROAD_TILES.cracked;
    }
    return ROAD_TILES.normal;
  } else {
    // Debris zone - mostly empty with scattered road chunks
    if (rand < 0.15) {
      // 15% chance of debris tile
      if (rand2 < 0.5) {
        return ROAD_TILES.cracked;
      }
      return ROAD_TILES.worn;
    }
    // 85% show world terrain
    return null;
  }
}

/**
 * Generate terrain based on position
 */
function generateTerrain(x, y, width, height) {
  // Use actual base center, not geometric map center
  const centerX = BASE_CENTER.x;
  const centerY = BASE_CENTER.y;
  
  // Check for road first - roads extend to map edges
  const roadTile = getRoadTile(x, y, centerX, centerY);
  if (roadTile) {
    return roadTile;
  }
  
  const distFromCenter = Math.hypot(x - centerX, y - centerY);
  const maxDist = Math.hypot(width / 2, height / 2);
  const normalizedDist = distFromCenter / maxDist;

  // Add some noise for variety
  const noise = seededRandom(x * 1000 + y);
  
  // Desert near center, transitions to rocky/ash further out
  if (normalizedDist < 0.3) {
    // Inner desert zone
    return TERRAIN.DESERT[Math.floor(noise * TERRAIN.DESERT.length)];
  } else if (normalizedDist < 0.5) {
    // Mixed desert/rock zone
    if (noise < 0.7) {
      return TERRAIN.DESERT[Math.floor(noise * TERRAIN.DESERT.length)];
    }
    return TERRAIN.ROCK[0];
  } else if (normalizedDist < 0.7) {
    // Ash wastes
    if (noise < 0.6) {
      return TERRAIN.ASH[0];
    }
    return TERRAIN.ROCK[0];
  } else {
    // Salt flats at edges
    if (noise < 0.4) {
      return TERRAIN.SALT[0];
    } else if (noise < 0.7) {
      return TERRAIN.ASH[0];
    }
    return TERRAIN.ROCK[0];
  }
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
  const baseBuffer = 40; // Don't place lamps too close to base
  
  // Vertical road (N-S) - place lamps on left and right sides
  let nextLampY = borderBuffer;
  while (nextLampY < height - borderBuffer) {
    const distFromBase = Math.abs(nextLampY - centerY);
    
    // Skip if too close to base
    if (distFromBase > baseBuffer) {
      // Skip if in original map area
      const inOriginal = nextLampY >= offsetY && nextLampY < offsetY + ORIGINAL_HEIGHT;
      
      if (!inOriginal) {
        const rand = seededRandom(nextLampY * 777);
        
        // Place lamp on left side (west)
        if (rand < 0.7) { // 70% chance
          objects.push({
            id: `lamp_road_${id++}`,
            type: 'lamp',
            x: centerX - lampOffset,
            y: nextLampY,
            solid: true,
            light: { radius: 5, color: '#FFE4B5', intensity: 0.6 }
          });
        }
        
        // Place lamp on right side (east) - offset so not directly across
        const randRight = seededRandom(nextLampY * 888 + 500);
        if (randRight < 0.7) {
          objects.push({
            id: `lamp_road_${id++}`,
            type: 'lamp',
            x: centerX + lampOffset,
            y: nextLampY + Math.floor(seededRandom(nextLampY * 999) * 6) - 3,
            solid: true,
            light: { radius: 5, color: '#FFE4B5', intensity: 0.6 }
          });
        }
      }
    }
    
    // Random spacing to next lamp
    const spacing = LAMP_SPACING_MIN + Math.floor(seededRandom(nextLampY * 123) * (LAMP_SPACING_MAX - LAMP_SPACING_MIN));
    nextLampY += spacing;
  }
  
  // Horizontal road (E-W) - place lamps on top and bottom sides
  let nextLampX = borderBuffer;
  while (nextLampX < width - borderBuffer) {
    const distFromBase = Math.abs(nextLampX - centerX);
    
    // Skip if too close to base
    if (distFromBase > baseBuffer) {
      // Skip if in original map area
      const inOriginal = nextLampX >= offsetX && nextLampX < offsetX + ORIGINAL_WIDTH;
      
      if (!inOriginal) {
        const rand = seededRandom(nextLampX * 555);
        
        // Place lamp on top side (north)
        if (rand < 0.7) {
          objects.push({
            id: `lamp_road_${id++}`,
            type: 'lamp',
            x: nextLampX,
            y: centerY - lampOffset,
            solid: true,
            light: { radius: 5, color: '#FFE4B5', intensity: 0.6 }
          });
        }
        
        // Place lamp on bottom side (south)
        const randBottom = seededRandom(nextLampX * 666 + 500);
        if (randBottom < 0.7) {
          objects.push({
            id: `lamp_road_${id++}`,
            type: 'lamp',
            x: nextLampX + Math.floor(seededRandom(nextLampX * 444) * 6) - 3,
            y: centerY + lampOffset,
            solid: true,
            light: { radius: 5, color: '#FFE4B5', intensity: 0.6 }
          });
        }
      }
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

