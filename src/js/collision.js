/**
 * VETUU — Collision Module
 * Movement validation, object/NPC lookup, line-of-sight
 * 
 * OPTIMIZATION: Uses spatial index (Map) for O(1) lookups instead of O(n) array scans
 */

import { hasFlag } from './save.js';

// ============================================
// SPATIAL INDEX - O(1) lookups
// ============================================
let objectIndex = null;  // Map<"x,y", object>
let npcIndex = null;     // Map<"x,y", npc>
let bossIndex = null;    // Map<"x,y", boss>

/**
 * Build spatial indices for fast lookups. Call this once after map loads.
 */
export function buildSpatialIndex(state) {
  // Object index
  objectIndex = new Map();
  for (const obj of state.map.objects) {
    const key = `${obj.x},${obj.y}`;
    // Store first object at each position (matches old behavior)
    if (!objectIndex.has(key)) {
      objectIndex.set(key, obj);
    }
  }
  
  // NPC index
  npcIndex = new Map();
  for (const npc of state.entities.npcs) {
    npcIndex.set(`${npc.x},${npc.y}`, npc);
  }
  
  // Boss index
  bossIndex = new Map();
  for (const boss of state.entities.bosses) {
    bossIndex.set(`${boss.x},${boss.y}`, boss);
  }
  
  console.log(`[Collision] Spatial index built: ${objectIndex.size} objects, ${npcIndex.size} NPCs, ${bossIndex.size} bosses`);
}

// ============================================
// MOVEMENT VALIDATION
// ============================================
export function canMoveTo(state, x, y) {
  const { map } = state;

  // Bounds check
  if (x < 0 || y < 0 || x >= map.meta.width || y >= map.meta.height) {
    return false;
  }

  // Ground tile walkability
  const row = map.ground[y];
  if (!row) return false;

  const tileChar = row[x];
  if (tileChar === undefined) return false;

  // Look up by character directly (legend keys are strings)
  const tileDef = map.legend.tiles[tileChar];

  if (!tileDef || !tileDef.walkable) {
    return false;
  }

  // Object collision
  const obj = getObjectAt(state, x, y);
  if (obj) {
    // Check conditional visibility first
    if (obj.requires) {
      // flagNot: solid only when flag is NOT set
      if (obj.requires.flagNot) {
        if (hasFlag(state, obj.requires.flagNot)) {
          // Flag IS set, so this blocker is removed/not solid
          return true;
        }
      }
      // flag: only exists when flag IS set
      if (obj.requires.flag) {
        if (!hasFlag(state, obj.requires.flag)) {
          // Flag not set, object doesn't exist yet
          return true;
        }
      }
    }

    // Check if object is solid
    if (obj.solid) {
      return false;
    }
  }

  // NPC collision (can't walk through NPCs)
  const npc = getNpcAt(state, x, y);
  if (npc) {
    // Check if NPC is visible
    if (npc.requires?.flag && !hasFlag(state, npc.requires.flag)) {
      // NPC not visible, can walk through
      return true;
    }
    if (npc.flags?.hidden) {
      // Hidden NPC, can walk through
      return true;
    }
    return false;
  }

  // Enemy collision
  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp > 0 && enemy.x === x && enemy.y === y) {
      return false;
    }
  }

  // Boss collision
  const boss = getBossAt(state, x, y);
  if (boss) {
    if (boss.requires?.flag && !hasFlag(state, boss.requires.flag)) {
      return true; // Boss not visible
    }
    if (state.runtime.defeatedBosses?.has(boss.id)) {
      return true; // Boss defeated
    }
    return false;
  }

  return true;
}

/**
 * Like canMoveTo but ignores other enemies.
 * Used for Push/Pull abilities where we want to move through enemy positions.
 */
export function canMoveToIgnoreEnemies(state, x, y) {
  const { map } = state;

  // Bounds check
  if (x < 0 || y < 0 || x >= map.meta.width || y >= map.meta.height) {
    return false;
  }

  // Ground tile walkability
  const row = map.ground[y];
  if (!row) return false;

  const tileChar = row[x];
  if (tileChar === undefined) return false;

  const tileDef = map.legend.tiles[tileChar];
  if (!tileDef || !tileDef.walkable) {
    return false;
  }

  // Object collision
  const obj = getObjectAt(state, x, y);
  if (obj) {
    if (obj.requires) {
      if (obj.requires.flagNot) {
        if (hasFlag(state, obj.requires.flagNot)) {
          return true;
        }
      }
      if (obj.requires.flag) {
        if (!hasFlag(state, obj.requires.flag)) {
          return true;
        }
      }
    }
    if (obj.solid) {
      return false;
    }
  }

  // NPC collision (can't push into NPCs)
  const npc = getNpcAt(state, x, y);
  if (npc) {
    if (npc.requires?.flag && !hasFlag(state, npc.requires.flag)) {
      return true;
    }
    if (npc.flags?.hidden) {
      return true;
    }
    return false;
  }

  // SKIP enemy collision check - that's the difference from canMoveTo

  // Boss collision
  const boss = getBossAt(state, x, y);
  if (boss) {
    if (boss.requires?.flag && !hasFlag(state, boss.requires.flag)) {
      return true;
    }
    if (state.runtime.defeatedBosses?.has(boss.id)) {
      return true;
    }
    return false;
  }

  return true;
}

// ============================================
// LINE OF SIGHT (Bresenham's line algorithm)
// ============================================
export function hasLineOfSight(state, x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;

  let x = x1;
  let y = y1;

  while (true) {
    // Check if current tile blocks LOS
    if (x !== x1 || y !== y1) { // Skip starting position
      if (x !== x2 || y !== y2) { // Skip ending position
        if (isLOSBlocked(state, x, y)) {
          return false;
        }
      }
    }

    if (x === x2 && y === y2) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }

  return true;
}

function isLOSBlocked(state, x, y) {
  // Bounds check
  if (x < 0 || y < 0 || x >= state.map.meta.width || y >= state.map.meta.height) {
    return true;
  }

  // Check for solid objects that block LOS (walls, etc.)
  const obj = getObjectAt(state, x, y);
  if (obj) {
    // Walls block LOS, other solid objects might not
    if (obj.type === 'wall' || obj.type === 'act3_blocker') {
      // Check if blocker is active
      if (obj.requires?.flagNot && hasFlag(state, obj.requires.flagNot)) {
        return false; // Blocker removed
      }
      return true;
    }
  }

  return false;
}

// ============================================
// OBJECT LOOKUP (O(1) with spatial index)
// ============================================
export function getObjectAt(state, x, y) {
  // Use spatial index if available (O(1))
  if (objectIndex) {
    return objectIndex.get(`${x},${y}`) || null;
  }
  // Fallback to linear scan (O(n)) - only before index is built
  return state.map.objects.find(obj => obj.x === x && obj.y === y);
}

// ============================================
// NPC LOOKUP (O(1) with spatial index)
// ============================================
export function getNpcAt(state, x, y) {
  // Use spatial index if available (O(1))
  if (npcIndex) {
    return npcIndex.get(`${x},${y}`) || null;
  }
  // Fallback to linear scan (O(n))
  return state.entities.npcs.find(npc => npc.x === x && npc.y === y);
}

/**
 * Update NPC position in spatial index (for patrol movement)
 */
export function updateNpcPosition(npc, oldX, oldY, newX, newY) {
  if (!npcIndex) return;
  
  // Remove from old position
  const oldKey = `${oldX},${oldY}`;
  if (npcIndex.get(oldKey) === npc) {
    npcIndex.delete(oldKey);
  }
  
  // Add to new position
  npcIndex.set(`${newX},${newY}`, npc);
}

// ============================================
// ENEMY LOOKUP
// ============================================
export function getEnemyAt(state, x, y) {
  // Check active enemies
  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp > 0 && enemy.x === x && enemy.y === y) {
      return enemy;
    }
  }
  return null;
}

// Get enemy spawn area at position
export function getEnemySpawnAt(state, x, y) {
  for (const spawn of state.entities.enemies) {
    const dist = Math.hypot(x - spawn.center.x, y - spawn.center.y);
    if (dist <= spawn.radius) {
      return spawn;
    }
  }
  return null;
}

// ============================================
// BOSS LOOKUP (O(1) with spatial index)
// ============================================
export function getBossAt(state, x, y) {
  // Use spatial index if available (O(1))
  if (bossIndex) {
    return bossIndex.get(`${x},${y}`) || null;
  }
  // Fallback to linear scan (O(n))
  return state.entities.bosses.find(boss => boss.x === x && boss.y === y);
}

// ============================================
// REGION LOOKUP
// ============================================
export function getRegionAt(state, x, y) {
  for (const region of state.map.regions) {
    const b = region.bounds;
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      return region;
    }
  }
  return null;
}

// ============================================
// DISTANCE HELPERS
// ============================================
export function distanceBetween(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function manhattanDistance(x1, y1, x2, y2) {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

export function isAdjacent(x1, y1, x2, y2) {
  return manhattanDistance(x1, y1, x2, y2) === 1;
}

// ============================================
// FIND VALID POSITION
// ============================================
export function findOpenPosition(state, centerX, centerY, radius = 5) {
  // Spiral search for open position
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = centerX + dx;
        const y = centerY + dy;
        if (canMoveTo(state, x, y)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}
