/**
 * VETUU — Map Generator
 * Procedurally expands the base map 4x (120x80 → 480x320)
 * Drycross base centered at (240, 168) in expanded map
 */

// New map center (scaled)
export const BASE_CENTER = { 
  x: Math.floor(120 * 2), // 240 - center of 480 width
  y: Math.floor(80 * 2)   // 160 - center of 320 height
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
  cracked: 'f',
  missing: '0'  // Reverts to sand
};

/**
 * Check if position is on a road and return appropriate road tile
 * Roads run N-S and E-W through map center
 */
function getRoadTile(x, y, centerX, centerY) {
  const roadHalfWidth = 1;
  const isOnVerticalRoad = Math.abs(x - centerX) <= roadHalfWidth;
  const isOnHorizontalRoad = Math.abs(y - centerY) <= roadHalfWidth;
  
  if (!isOnVerticalRoad && !isOnHorizontalRoad) {
    return null;
  }
  
  // Apply weathering effect
  const rand = seededRandom(x * 1000 + y);
  if (rand < 0.06) {
    return ROAD_TILES.missing;
  } else if (rand < 0.18) {
    return ROAD_TILES.worn;
  } else if (rand < 0.26) {
    return ROAD_TILES.cracked;
  }
  return ROAD_TILES.normal;
}

/**
 * Generate terrain based on position
 */
function generateTerrain(x, y, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  
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

  const centerX = width / 2;
  const centerY = height / 2;

  // Scatter rocks and wrecks in the expanded areas
  for (let i = 0; i < 200; i++) {
    const x = Math.floor(seededRandom(i * 7) * width);
    const y = Math.floor(seededRandom(i * 13) * height);
    
    // Skip if in original map area or too close to center
    const distFromCenter = Math.hypot(x - centerX, y - centerY);
    if (distFromCenter < 50) continue;
    if (x >= offsetX && x < offsetX + 120 && y >= offsetY && y < offsetY + 80) continue;

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

