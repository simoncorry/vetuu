/**
 * VETUU — Spawn Director
 * 
 * Centralized spawn management system that:
 * - Manages enemy spawning based on distance bands (rings)
 * - Enforces density caps and spacing rules
 * - Supports NPE (New Player Experience) safety
 * - Supports Act 3 world state modifiers
 * - Creates natural mix of strays and packs
 */

import { canMoveTo } from './collision.js';
import { hasFlag } from './save.js';
import { distCoords, randomRange } from './utils.js';
import { AI } from './aiConstants.js';
import { nowMs } from './time.js';
import { normalizeHealthKeys, clampHP } from './entityCompat.js';

// ============================================
// CONSTANTS - DISTANCE RINGS
// ============================================
const RINGS = {
  safe:       { min: 0,  max: 18 },
  frontier:   { min: 19, max: 40 },
  wilderness: { min: 41, max: 70 },
  danger:     { min: 71, max: Infinity }
};

// ============================================
// CONSTANTS - DENSITY & SPAWNING
// ============================================
const ACTIVE_RADIUS = 26;           // Bubble around player for spawn decisions
const NO_SPAWN_RADIUS = 10;         // Don't spawn within this range of player
const SPAWN_TICK_MS = 500;          // How often to check spawns

// Density caps within active bubble
const MAX_STRAYS = 6;
const MAX_PACKS = 2;
const MAX_TOTAL_ENEMIES = 12;

// NPE (New Player Experience) critter guarantees
const NPE_CRITTER_MIN = 2;
const NPE_CRITTER_ZONE_MIN = 8;     // Min distance from base for NPE critters
const NPE_CRITTER_ZONE_MAX = 16;    // Max distance from base for NPE critters

// Respawn timing
const STRAY_RESPAWN_MS = { min: 90000, max: 180000 };
const PACK_RESPAWN_MS = { min: 240000, max: 600000 };

// ============================================
// CONSTANTS - RING SPAWN WEIGHTS
// ============================================
const RING_WEIGHTS = {
  safe:       { stray: 1.0, pack: 0.0 },
  frontier:   { stray: 0.5, pack: 0.5 },
  wilderness: { stray: 0.3, pack: 0.7 },
  danger:     { stray: 0.2, pack: 0.8 }
};

// Act 3 modifiers
const ACT3_MODIFIERS = {
  karthMultiplier: 1.8,
  neutralWildlifeMultiplier: 0.7
};

// ============================================
// SPAWN BLOCK CONSTANTS
// ============================================
const BLOCK_SIZE = 3;           // 3×3 tiles per spawn footprint
const BLOCK_STRIDE = 4;         // Block spacing (4 = 1-tile buffer between footprints)
const MIN_PACK_SIZE = 2;        // Minimum enemies per pack
const MAX_PACK_SIZE = 8;        // Maximum enemies per pack

// ============================================
// STATE
// ============================================
let currentState = null;
let baseCenter = { x: 236, y: 162 };  // Will be set from map offset
let baseBounds = null;
let baseBuffer = 4;
let spawners = [];
let lastPickedSpawnerId = null;
let spawnTickInterval = null;

// ============================================
// TILE RESERVATION SYSTEM
// ============================================
// Tracks all reserved tiles (spawn footprints)
// Key format: "x,y"
const reservedTiles = new Set();

/**
 * Check if a tile is reserved by any enemy's spawn footprint.
 */
function isReserved(x, y) {
  return reservedTiles.has(`${x},${y}`);
}

/**
 * Get all 9 tiles in a 3×3 block centered at (cx, cy).
 * @returns {Array<{x: number, y: number}>} Array of 9 tile positions
 */
function getBlockTiles(cx, cy) {
  const tiles = [];
  const half = Math.floor(BLOCK_SIZE / 2); // 1 for 3×3
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      tiles.push({ x: cx + dx, y: cy + dy });
    }
  }
  return tiles;
}

/**
 * Check if a 3×3 block centered at (cx, cy) is valid for spawning.
 * Valid means: all 9 tiles walkable, none reserved, none in base bounds.
 */
function isBlockValid(cx, cy) {
  const tiles = getBlockTiles(cx, cy);
  
  for (const tile of tiles) {
    // Check walkability
    if (!canMoveTo(currentState, tile.x, tile.y)) {
      return false;
    }
    // Check reservation
    if (isReserved(tile.x, tile.y)) {
      return false;
    }
    // Check base exclusion
    if (isInsideBaseBounds(tile.x, tile.y)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Reserve all tiles in a block.
 * @param {Array<{x: number, y: number}>} tiles - Tiles to reserve
 */
function reserveBlock(tiles) {
  for (const tile of tiles) {
    reservedTiles.add(`${tile.x},${tile.y}`);
  }
}

/**
 * Release all tiles in a block.
 * @param {Array<{x: number, y: number}>} tiles - Tiles to release
 */
function releaseBlock(tiles) {
  for (const tile of tiles) {
    reservedTiles.delete(`${tile.x},${tile.y}`);
  }
}

/**
 * Release enemy's reserved block when they die or despawn.
 */
export function releaseEnemyBlock(enemy) {
  if (enemy.reservedTiles && Array.isArray(enemy.reservedTiles)) {
    releaseBlock(enemy.reservedTiles);
  }
}

// ============================================
// ENEMY TYPE DEFINITIONS (Simplified Combat)
// ============================================
// All enemies are either melee or ranged
// - Melee: range = 2, faster movement (320-380ms)
// - Ranged: range = 6, slower movement (420-480ms)
const ENEMY_TYPES = {
  // Nomads (passive wanderers, always solo, melee)
  nomad: {
    name: 'Nomad',
    baseHp: 25,
    baseAtk: 4,
    baseDef: 2,
    color: '#8B7355',
    combatType: 'melee',
    weapon: 'melee_club',
    moveSpeed: 360, // Moderate speed
    defaultAggroType: 'passive',
    defaultAggroRadius: 3,
    defaultLeashRadius: 10,
    defaultDeaggroMs: 3000
  },
  
  // Scavengers - ranged variant
  scav_ranged: {
    name: 'Scav Shooter',
    baseHp: 30,
    baseAtk: 10,
    baseDef: 2,
    color: '#8B4513',
    combatType: 'ranged',
    weapon: 'ranged_rifle',
    projectileColor: '#9B59B6',
    moveSpeed: 450,
    defaultAggroType: 'conditional',
    defaultAggroRadius: 6,
    defaultLeashRadius: 14,
    defaultDeaggroMs: 4000
  },
  // Scavengers - melee variant  
  scav_melee: {
    name: 'Scav Brawler',
    baseHp: 45,
    baseAtk: 12,
    baseDef: 4,
    color: '#8B5A2B',
    combatType: 'melee',
    weapon: 'melee_club',
    moveSpeed: 350, // Fast melee
    defaultAggroType: 'conditional',
    defaultAggroRadius: 5,
    defaultLeashRadius: 12,
    defaultDeaggroMs: 4000
  },
  
  // Trog Warband - melee warrior
  trog_warrior: {
    name: 'Trog Warrior',
    baseHp: 50,
    baseAtk: 14,
    baseDef: 5,
    color: '#556B2F',
    combatType: 'melee',
    weapon: 'melee_spear',
    moveSpeed: 320, // Fast melee
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 8,
    defaultLeashRadius: 18,
    defaultDeaggroMs: 5000
  },
  // Trog Warband - ranged shaman
  trog_shaman: {
    name: 'Trog Shaman',
    baseHp: 35,
    baseAtk: 18,
    baseDef: 3,
    color: '#6B8E23',
    combatType: 'ranged',
    weapon: 'ranged_bolt',
    projectileColor: '#2ECC71',
    moveSpeed: 480,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 10,
    defaultLeashRadius: 16,
    defaultDeaggroMs: 5000
  },
  
  // Karth Directorate - ranged soldier
  karth_grunt: {
    name: 'Karth Soldier',
    baseHp: 55,
    baseAtk: 16,
    baseDef: 6,
    color: '#4A4A4A',
    combatType: 'ranged',
    weapon: 'karth_laser',
    projectileColor: '#E74C3C',
    moveSpeed: 420,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 10,
    defaultLeashRadius: 20,
    defaultDeaggroMs: 6000
  },
  // Karth Directorate - melee officer
  karth_officer: {
    name: 'Karth Officer',
    baseHp: 70,
    baseAtk: 20,
    baseDef: 8,
    color: '#2F2F2F',
    combatType: 'melee',
    weapon: 'melee_club',
    moveSpeed: 350, // Fast melee
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 8,
    defaultLeashRadius: 18,
    defaultDeaggroMs: 6000
  }
};


// ============================================
// INITIALIZATION
// ============================================
export function initSpawnDirector(state) {
  currentState = state;
  
  // Set base center from map offset
  if (state.map?.meta?.originalOffset) {
    const ox = state.map.meta.originalOffset.x;
    const oy = state.map.meta.originalOffset.y;
    baseCenter = { x: 56 + ox, y: 42 + oy };
    
    // Define base bounds (guards are at these perimeter positions)
    baseBounds = {
      minX: 44 + ox,
      maxX: 64 + ox,
      minY: 29 + oy,
      maxY: 46 + oy
    };
  }
  
  // Initialize spawners from data
  initializeSpawners(state);
  
  // Start spawn tick
  if (spawnTickInterval) clearInterval(spawnTickInterval);
  spawnTickInterval = setInterval(() => spawnDirectorTick(), SPAWN_TICK_MS);
  
  console.log(`[SpawnDirector] Initialized with ${spawners.length} spawners, base center: (${baseCenter.x}, ${baseCenter.y})`);
}

function initializeSpawners(state) {
  spawners = [];
  
  // Convert old enemy spawn data to new format, or use new spawner definitions
  if (state.spawnerDefs) {
    // New format - use directly
    // Initialize lastSpawnAt to -Infinity so spawners are immediately eligible
    spawners = state.spawnerDefs.map(def => ({
      ...def,
      lastSpawnAt: -Infinity,
      aliveCount: 0
    }));
  } else {
    // Generate default spawners based on rings
    spawners = generateDefaultSpawners();
  }
}

// ============================================
// DEFAULT SPAWNER GENERATION
// ============================================
function generateDefaultSpawners() {
  const result = [];
  let id = 0;
  
  // ============================================
  // INNER RING: NOMADS (Solo only, Level 1-5)
  // ============================================
  // Nomads are always solo wanderers, never in packs.
  // Level scales with distance from base: 1-2 close, 3-4 mid, 4-5 outer
  
  // Inner nomads (level 1-2, closest to base)
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const dist = 6 + Math.random() * 4; // 6-10 tiles from center
    result.push({
      id: `sp_nomad_inner_${id++}`,
      kind: 'stray',
      ring: 'safe',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 3,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['nomad'],
      levelRange: [1, 2],
      aggroType: 'passive',
      aggroRadius: 3,
      leashRadius: 8,
      deaggroTimeMs: 3000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      isNpeCritter: true
    });
  }
  
  // Mid nomads (level 2-4, middle distance)
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 16;
    const dist = 10 + Math.random() * 4; // 10-14 tiles from center
    result.push({
      id: `sp_nomad_mid_${id++}`,
      kind: 'stray',
      ring: 'safe',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 4,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['nomad'],
      levelRange: [2, 4],
      aggroType: 'passive',
      aggroRadius: 3,
      leashRadius: 10,
      deaggroTimeMs: 3000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      isNpeCritter: true
    });
  }
  
  // Outer nomads (level 4-5, edge of inner ring)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 12;
    const dist = 14 + Math.random() * 4; // 14-18 tiles from center
    result.push({
      id: `sp_nomad_outer_${id++}`,
      kind: 'stray',
      ring: 'safe',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 4,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['nomad'],
      levelRange: [4, 5],
      aggroType: 'passive',
      aggroRadius: 3,
      leashRadius: 10,
      deaggroTimeMs: 3000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      isNpeCritter: true
    });
  }
  
  // ============================================
  // SCAV PACKS (Always packs of 3-8, Level 6+)
  // ============================================
  // Scavs are always in packs, never solo. They start at the border of the inner ring.
  
  // Inner scav packs (level 6-8, just past nomad territory)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dist = 20 + Math.random() * 6; // 20-26 tiles from center
    result.push({
      id: `sp_pack_scav_inner_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 6,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_ranged', 'scav_melee'],
      levelRange: [6, 8],
      packSize: { min: 3, max: 5 },
      alpha: { chance: 0.2, max: 1 },
      aggroType: 'conditional',
      aggroRadius: 6,
      leashRadius: 14,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 14
    });
  }
  
  // Mid scav packs (level 8-10, frontier territory)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const dist = 28 + Math.random() * 8; // 28-36 tiles from center
    result.push({
      id: `sp_pack_scav_mid_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 7,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_ranged', 'scav_melee'],
      levelRange: [8, 10],
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.3, max: 1 },
      aggroType: 'conditional',
      aggroRadius: 6,
      leashRadius: 16,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 14
    });
  }
  
  // Outer scav packs (level 10-12, edge of frontier)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dist = 38 + Math.random() * 8; // 38-46 tiles from center
    result.push({
      id: `sp_pack_scav_outer_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 8,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_ranged', 'scav_melee'],
      levelRange: [10, 12],
      packSize: { min: 5, max: 8 },
      alpha: { chance: 0.35, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 7,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 16
    });
  }
  
  // ============================================
  // WILDERNESS RING: TROGS (Packs, Level 12+)
  // ============================================
  // Trogs are aggressive warband packs in the wilderness
  
  // Trog warbands (level 12-15)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dist = 50 + Math.random() * 15; // 50-65 tiles from center
    result.push({
      id: `sp_pack_trog_${id++}`,
      kind: 'pack',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 8,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['trog_warrior', 'trog_shaman'],
      levelRange: [12, 15],
      packSize: { min: 4, max: 7 },
      alpha: { chance: 0.4, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 8,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 16
    });
  }
  
  // ============================================
  // DANGER RING: KARTH (Packs, Level 16+)
  // ============================================
  // Karth Directorate patrols - elite military packs
  
  // Inner Karth patrols (level 16-18)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const dist = 72 + Math.random() * 10; // 72-82 tiles from center
    result.push({
      id: `sp_pack_karth_inner_${id++}`,
      kind: 'pack',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 10,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [16, 18],
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.4, max: 1 },
      aggroType: 'aggressive',
      aggroRadius: 10,
      leashRadius: 20,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 18,
      requires: { flag: 'act3' }  // Only in Act 3
    });
  }
  
  // Outer Karth patrols (level 18-22, elite squads)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dist = 85 + Math.random() * 15; // 85-100 tiles from center
    result.push({
      id: `sp_pack_karth_outer_${id++}`,
      kind: 'pack',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 10,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [18, 22],
      packSize: { min: 5, max: 8 },
      alpha: { chance: 0.5, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 10,
      leashRadius: 20,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 18,
      requires: { flag: 'act3' }  // Only in Act 3
    });
  }
  
  return result;
}

// ============================================
// MAIN SPAWN TICK
// ============================================
function spawnDirectorTick() {
  if (!currentState) return;
  
  const now = nowMs();
  const player = currentState.player;
  
  // Don't spawn while ghost running
  if (document.getElementById('player')?.classList.contains('ghost')) return;
  
  // Get current enemy counts in active bubble
  const bubble = getActiveBubble(player);
  const counts = countEnemiesInBubble(bubble);
  
  // 1) Guarantee NPE critters near base
  const playerDist = distCoords(player.x, player.y, baseCenter.x, baseCenter.y);
  if (playerDist <= RINGS.safe.max + 10) {
    const forcedSpawns = ensureNpeCritters(now, counts);
    if (forcedSpawns.length > 0) {
      executeSpawnRequests(forcedSpawns);
      return;
    }
  }
  
  // 2) Eligibility filter
  const eligible = spawners.filter(s => isSpawnerEligible(s, now, counts));
  
  if (eligible.length === 0) return;
  
  // 3) Score & pick (weighted random)
  const pick = chooseSpawner(eligible, counts);
  if (!pick) return;
  
  // 4) Build spawn request
  const request = buildSpawnRequest(pick);
  if (!request) return;
  
  // 5) Commit bookkeeping
  pick.lastSpawnAt = now;
  lastPickedSpawnerId = pick.id;
  
  // 6) Execute spawn
  executeSpawnRequests([request]);
}

// ============================================
// ACTIVE BUBBLE & COUNTING
// ============================================
function getActiveBubble(player) {
  return {
    centerX: player.x,
    centerY: player.y,
    radius: ACTIVE_RADIUS
  };
}

function countEnemiesInBubble(bubble) {
  const enemies = currentState.runtime.activeEnemies || [];
  let strays = 0;
  let packs = 0;
  let total = 0;
  let elites = 0;
  const packIds = new Set();
  
  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    
    const dist = distCoords(enemy.x, enemy.y, bubble.centerX, bubble.centerY);
    if (dist > bubble.radius) continue;
    
    total++;
    
    if (enemy.isSoloCritter || enemy.isStray) {
      strays++;
    } else if (enemy.packId && !packIds.has(enemy.packId)) {
      packIds.add(enemy.packId);
      packs++;
    }
    
    if (enemy.isElite) elites++;
  }
  
  return { strays, packs, total, elites };
}

// ============================================
// NPE CRITTER GUARANTEES
// ============================================
function ensureNpeCritters(now, counts) {
  const requests = [];
  
  // Count alive NPE critters
  const enemies = currentState.runtime.activeEnemies || [];
  const npeCritters = enemies.filter(e => 
    e.hp > 0 && 
    e.isNpeCritter && 
    distCoords(e.x, e.y, baseCenter.x, baseCenter.y) <= RINGS.safe.max
  );
  
  if (npeCritters.length >= NPE_CRITTER_MIN) return [];
  
  // Find eligible NPE spawners
  const npeSpawners = spawners.filter(s => 
    s.isNpeCritter && 
    isSpawnerEligible(s, now, counts)
  );
  
  // Spawn one at a time until minimum reached
  const needed = NPE_CRITTER_MIN - npeCritters.length;
  for (let i = 0; i < Math.min(needed, npeSpawners.length); i++) {
    const spawner = npeSpawners[i];
    const request = buildSpawnRequest(spawner);
    if (request) {
      spawner.lastSpawnAt = now;
      requests.push(request);
    }
  }
  
  return requests;
}

// ============================================
// ELIGIBILITY RULES
// ============================================
function isSpawnerEligible(spawner, now, counts) {
  // A) Cooldown and maxAlive
  if (now - spawner.lastSpawnAt < spawner.respawnMs) return false;
  if (spawner.aliveCount >= spawner.maxAlive) return false;
  
  // B) Player distance
  const player = currentState.player;
  const playerDist = distCoords(player.x, player.y, spawner.center.x, spawner.center.y);
  
  // Don't spawn too close to player
  if (playerDist < spawner.noSpawnRadius) return false;
  
  // Must be within activation range
  if (playerDist > ACTIVE_RADIUS + spawner.spawnRadius + 10) return false;
  
  // C) Ring constraints (based on spawner center distance from base)
  const spawnerDistFromBase = distCoords(spawner.center.x, spawner.center.y, baseCenter.x, baseCenter.y);
  const spawnerRing = getRingForDistance(spawnerDistFromBase);
  
  if (spawner.ring && spawner.ring !== spawnerRing) {
    // Spawner is not in its designated ring - skip
    // (This allows manually placed spawners to override)
  }
  
  // D) Base bounds exclusion
  if (isInsideBaseBounds(spawner.center.x, spawner.center.y)) return false;
  
  // E) Density caps
  if (spawner.kind === 'pack' && counts.packs >= MAX_PACKS) return false;
  if (spawner.kind === 'stray' && counts.strays >= MAX_STRAYS) return false;
  if (counts.total >= MAX_TOTAL_ENEMIES) return false;
  
  // F) Spacing (for packs)
  if (spawner.kind === 'pack' && spawner.minDistanceToOtherPacks) {
    const enemies = currentState.runtime.activeEnemies || [];
    const packs = new Map(); // packId -> center position
    
    for (const e of enemies) {
      if (e.hp <= 0 || !e.packId || packs.has(e.packId)) continue;
      packs.set(e.packId, { x: e.homeCenter?.x || e.x, y: e.homeCenter?.y || e.y });
    }
    
    for (const [_packId, center] of packs) {
      const dist = distCoords(spawner.center.x, spawner.center.y, center.x, center.y);
      if (dist < spawner.minDistanceToOtherPacks) return false;
    }
  }
  
  // G) Gating (flags)
  if (spawner.requires?.flag && !hasFlag(currentState, spawner.requires.flag)) return false;
  if (spawner.forbids?.flag && hasFlag(currentState, spawner.forbids.flag)) return false;
  
  return true;
}

// ============================================
// WEIGHTED SPAWNER SELECTION
// ============================================
function chooseSpawner(eligible, _counts) {
  if (eligible.length === 0) return null;
  
  const isAct3 = hasFlag(currentState, 'act3');
  const weights = [];
  let totalWeight = 0;
  
  for (const spawner of eligible) {
    let weight = 1.0;
    
    // Base weight by ring and kind
    const spawnerDist = distCoords(spawner.center.x, spawner.center.y, baseCenter.x, baseCenter.y);
    const ring = getRingForDistance(spawnerDist);
    const ringWeights = RING_WEIGHTS[ring] || RING_WEIGHTS.frontier;
    
    if (spawner.kind === 'stray') {
      weight *= ringWeights.stray;
    } else if (spawner.kind === 'pack') {
      weight *= ringWeights.pack;
    }
    
    // Act 3 modifiers
    if (isAct3) {
      const pool = spawner.enemyPool || [];
      if (pool.some(t => t.startsWith('karth'))) {
        weight *= ACT3_MODIFIERS.karthMultiplier;
      }
      if (pool.includes('nomad') && spawner.aggroType === 'passive') {
        weight *= ACT3_MODIFIERS.neutralWildlifeMultiplier;
      }
    }
    
    // Anti-repeat: reduce weight if this was last picked
    if (spawner.id === lastPickedSpawnerId) {
      weight *= 0.25;
    }
    
    // NPE critters get slight boost when in safe zone
    if (spawner.isNpeCritter) {
      weight *= 1.2;
    }
    
    weights.push({ spawner, weight });
    totalWeight += weight;
  }
  
  if (totalWeight <= 0) return null;
  
  // Weighted random selection
  let roll = Math.random() * totalWeight;
  for (const { spawner, weight } of weights) {
    roll -= weight;
    if (roll <= 0) return spawner;
  }
  
  return weights[weights.length - 1]?.spawner;
}

// ============================================
// BUILD SPAWN REQUEST
// ============================================
function buildSpawnRequest(spawner) {
  const t = nowMs();
  const packId = spawner.kind === 'pack' ? `pack_${Math.floor(t)}_${Math.random().toString(36).substr(2, 5)}` : null;
  
  // Determine roster
  const roster = [];
  // Pack size: use spawner config if available, otherwise use global MIN/MAX (2-8)
  const size = spawner.kind === 'pack' 
    ? randomRange(
        spawner.packSize?.min ?? MIN_PACK_SIZE, 
        spawner.packSize?.max ?? MAX_PACK_SIZE
      )
    : 1;
  
  // Determine alphas for pack
  let alphaSlots = 0;
  if (spawner.kind === 'pack' && spawner.alpha) {
    for (let i = 0; i < size && alphaSlots < spawner.alpha.max; i++) {
      if (Math.random() < spawner.alpha.chance) alphaSlots++;
    }
  }
  
  let alphasAssigned = 0;
  for (let i = 0; i < size; i++) {
    const isAlpha = spawner.kind === 'pack' && alphasAssigned < alphaSlots;
    if (isAlpha) alphasAssigned++;
    
    const enemyType = spawner.enemyPool[Math.floor(Math.random() * spawner.enemyPool.length)];
    const level = randomRange(spawner.levelRange[0], spawner.levelRange[1]);
    
    roster.push({
      type: enemyType,
      level,
      isAlpha
    });
  }
  
  // Find spawn positions
  const positions = findSpawnPositions(spawner, roster.length);
  if (positions.length < roster.length) {
    console.warn(`[SpawnDirector] Could not find enough positions for spawner ${spawner.id}`);
    return null;
  }
  
  return {
    spawnerId: spawner.id,
    roster,
    positions,
    packId,
    metadata: {
      aggroType: spawner.aggroType,
      aggroRadius: spawner.aggroRadius,
      leashRadius: spawner.leashRadius,
      deaggroTimeMs: spawner.deaggroTimeMs,
      homeCenter: { ...spawner.center },
      isNpeCritter: spawner.isNpeCritter,
      isStray: spawner.kind === 'stray'
    }
  };
}

/**
 * Find a single valid 3×3 block for spawning.
 * Spiral searches outward from the spawn center.
 * @returns {{centerX: number, centerY: number, tiles: Array} | null}
 */
function findFreeBlock(spawner) {
  const player = currentState.player;
  const maxSearchRadius = Math.max(spawner.spawnRadius, 10);
  
  // Spiral search from spawner center
  for (let radius = 0; radius <= maxSearchRadius; radius++) {
    // Generate candidate positions at this radius
    const candidates = [];
    
    if (radius === 0) {
      candidates.push({ x: spawner.center.x, y: spawner.center.y });
    } else {
      // Perimeter of square at this radius
      for (let i = -radius; i <= radius; i++) {
        candidates.push({ x: spawner.center.x + i, y: spawner.center.y - radius }); // top
        candidates.push({ x: spawner.center.x + i, y: spawner.center.y + radius }); // bottom
        if (Math.abs(i) !== radius) {
          candidates.push({ x: spawner.center.x - radius, y: spawner.center.y + i }); // left
          candidates.push({ x: spawner.center.x + radius, y: spawner.center.y + i }); // right
        }
      }
    }
    
    // Shuffle candidates for variety
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    
    for (const candidate of candidates) {
      const cx = candidate.x;
      const cy = candidate.y;
      
      // Check player distance from block center
      if (distCoords(cx, cy, player.x, player.y) < NO_SPAWN_RADIUS) continue;
      
      // Check if full block is valid
      if (!isBlockValid(cx, cy)) continue;
      
      // Don't overlap existing enemy positions
      const enemies = currentState.runtime.activeEnemies || [];
      const tiles = getBlockTiles(cx, cy);
      const hasEnemyOverlap = enemies.some(e => 
        e.hp > 0 && tiles.some(t => t.x === e.x && t.y === e.y)
      );
      if (hasEnemyOverlap) continue;
      
      return { centerX: cx, centerY: cy, tiles };
    }
  }
  
  return null;
}

/**
 * Find N 3×3 blocks for a pack, arranged in a grid layout.
 * @param {object} spawner - The spawner config
 * @param {number} count - Number of blocks needed (one per enemy)
 * @returns {Array<{centerX: number, centerY: number, tiles: Array}> | null}
 */
function findPackBlockLayout(spawner, count) {
  const player = currentState.player;
  const maxAnchorAttempts = 30;
  
  // Calculate grid dimensions
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  
  // Total footprint size
  const layoutWidth = cols * BLOCK_STRIDE;
  const layoutHeight = rows * BLOCK_STRIDE;
  
  // Try different anchor positions
  for (let attempt = 0; attempt < maxAnchorAttempts; attempt++) {
    // Generate anchor position (top-left of pack layout)
    let anchorX, anchorY;
    
    if (attempt === 0) {
      // First try: centered on spawner
      anchorX = spawner.center.x - Math.floor(layoutWidth / 2);
      anchorY = spawner.center.y - Math.floor(layoutHeight / 2);
    } else {
      // Subsequent tries: random within spawn radius
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spawner.spawnRadius;
      anchorX = Math.round(spawner.center.x + Math.cos(angle) * dist) - Math.floor(layoutWidth / 2);
      anchorY = Math.round(spawner.center.y + Math.sin(angle) * dist) - Math.floor(layoutHeight / 2);
    }
    
    // Generate block centers in deterministic grid order
    const blocks = [];
    let blockIndex = 0;
    let allValid = true;
    
    for (let row = 0; row < rows && allValid; row++) {
      for (let col = 0; col < cols && allValid; col++) {
        if (blockIndex >= count) break;
        
        // Calculate block center
        // Each block is centered, so offset by half BLOCK_SIZE + stride * index
        const cx = anchorX + col * BLOCK_STRIDE + Math.floor(BLOCK_SIZE / 2);
        const cy = anchorY + row * BLOCK_STRIDE + Math.floor(BLOCK_SIZE / 2);
        
        // Check player distance
        if (distCoords(cx, cy, player.x, player.y) < NO_SPAWN_RADIUS) {
          allValid = false;
          break;
        }
        
        // Check block validity (walkable, not reserved, not in base)
        if (!isBlockValid(cx, cy)) {
          allValid = false;
          break;
        }
        
        // Don't overlap existing enemies
        const enemies = currentState.runtime.activeEnemies || [];
        const tiles = getBlockTiles(cx, cy);
        const hasEnemyOverlap = enemies.some(e =>
          e.hp > 0 && tiles.some(t => t.x === e.x && t.y === e.y)
        );
        if (hasEnemyOverlap) {
          allValid = false;
          break;
        }
        
        // Check we don't overlap already-picked blocks in this layout
        const overlapsOther = blocks.some(other =>
          other.tiles.some(ot => tiles.some(t => t.x === ot.x && t.y === ot.y))
        );
        if (overlapsOther) {
          allValid = false;
          break;
        }
        
        blocks.push({ centerX: cx, centerY: cy, tiles });
        blockIndex++;
      }
    }
    
    if (allValid && blocks.length === count) {
      return blocks;
    }
  }
  
  return null;
}

/**
 * Find spawn positions (blocks) for enemies.
 * For packs: uses grid layout algorithm.
 * For strays: finds single block.
 * @returns {Array<{x: number, y: number, blockTiles: Array}>} Spawn positions with reserved tiles
 */
function findSpawnPositions(spawner, count) {
  if (count === 1) {
    // Single enemy: find one block
    const block = findFreeBlock(spawner);
    if (!block) return [];
    
    return [{
      x: block.centerX,
      y: block.centerY,
      blockTiles: block.tiles
    }];
  }
  
  // Pack: find grid layout of blocks
  const blocks = findPackBlockLayout(spawner, count);
  if (!blocks) return [];
  
  return blocks.map(block => ({
    x: block.centerX,
    y: block.centerY,
    blockTiles: block.tiles
  }));
}

// ============================================
// EXECUTE SPAWN REQUESTS
// ============================================
function executeSpawnRequests(requests) {
  for (const request of requests) {
    for (let i = 0; i < request.roster.length; i++) {
      const rosterEntry = request.roster[i];
      const position = request.positions[i];
      
      // Reserve the block tiles BEFORE creating the enemy
      if (position.blockTiles) {
        reserveBlock(position.blockTiles);
      }
      
      const enemy = createEnemy(rosterEntry, position, request);
      currentState.runtime.activeEnemies.push(enemy);
      
      // Update spawner alive count
      const spawner = spawners.find(s => s.id === request.spawnerId);
      if (spawner) spawner.aliveCount++;
    }
  }
  
  // Render the new enemies
  import('./combat.js').then(combat => {
    combat.renderEnemies(currentState);
  });
}

/**
 * Apply alpha modifications to an enemy ONCE at spawn time.
 * Alpha power is purely from stats - no hidden combat multipliers.
 */
function applyAlphaMods(enemy) {
  enemy.isAlpha = true;
  
  // Alpha stat bonuses: +35% HP, +25% ATK, +15% DEF
  enemy.maxHP = Math.round(enemy.maxHP * 1.35);
  enemy.hp = Math.min(enemy.hp, enemy.maxHP);
  enemy.atk = Math.round(enemy.atk * 1.25);
  enemy.def = Math.round(enemy.def * 1.15);
  
  // Keep alias synced
  enemy.maxHp = enemy.maxHP;
}

function createEnemy(rosterEntry, position, request) {
  const typeDef = ENEMY_TYPES[rosterEntry.type] || ENEMY_TYPES.nomad;
  const level = rosterEntry.level;
  // Use performance.now() for all simulation timing
  const t = nowMs();
  
  // Calculate base stats with level scaling (NO alpha mult here)
  const hpScale = 1 + (level - 1) * 0.15;   // +15% HP per level
  const atkScale = 1 + (level - 1) * 0.12;  // +12% ATK per level
  const defScale = 1 + (level - 1) * 0.10;  // +10% DEF per level
  
  // Base stats without alpha modifier
  const hp = Math.floor(typeDef.baseHp * hpScale);
  const atk = Math.floor(typeDef.baseAtk * atkScale);
  const def = Math.floor(typeDef.baseDef * defScale);
  
  // Per-enemy spawn position (center of their 3×3 block)
  // This is the authoritative position - NOT a shared pack center
  const spawnX = position.x;
  const spawnY = position.y;
  
  // Home point is per-enemy (their own spawn), not shared pack center
  // This ensures unique retreat destinations
  const home = { x: spawnX, y: spawnY };
  
  // Legacy homeCenter (optional, for visuals/debug only)
  const homeCenter = request.metadata.homeCenter || { x: spawnX, y: spawnY };
  
  const enemy = {
    id: `enemy_${Math.floor(t)}_${Math.random().toString(36).substr(2, 8)}`,
    spawnerId: request.spawnerId,
    packId: request.packId,
    
    // Identity
    name: typeDef.name,
    type: rosterEntry.type,
    level,
    isAlpha: rosterEntry.isAlpha,
    
    // Position (current)
    x: spawnX,
    y: spawnY,
    
    // Spawn position (authoritative for retreat)
    spawnX,
    spawnY,
    
    // Reserved tiles (for release on death/despawn)
    reservedTiles: position.blockTiles || [],
    
    // Home/leash point (per-enemy, NOT shared pack center)
    home,
    homeCenter, // Legacy compatibility (pack center for visuals only)
    packHomeCenter: homeCenter, // Explicit pack center reference for debug
    
    // Stats (canonical: maxHP, legacy alias: maxHp)
    hp,
    maxHP: hp,
    maxHp: hp,  // Legacy alias - kept for backward compatibility
    atk,
    def,
    
    // Appearance
    color: typeDef.color,
    weapon: typeDef.weapon,
    projectileColor: typeDef.projectileColor,
    moveSpeed: typeDef.moveSpeed,
    
    // Behavior parameters (from spawner or defaults)
    // Alphas get modest aggro/leash boost, not map-wide police
    aggroType: request.metadata.aggroType || 'aggressive',
    aggroRadius: request.metadata.aggroRadius || (rosterEntry.isAlpha ? AI.DEFAULT_AGGRO_RADIUS + 2 : AI.DEFAULT_AGGRO_RADIUS),
    leashRadius: request.metadata.leashRadius || (rosterEntry.isAlpha ? AI.DEFAULT_LEASH_RADIUS + 4 : AI.DEFAULT_LEASH_RADIUS),
    deaggroTimeMs: request.metadata.deaggroTimeMs || AI.DISENGAGE_GRACE_MS,
    
    // AI State (using new state machine)
    state: AI.STATES.UNAWARE,
    isAware: false,
    isEngaged: false,
    isRetreating: false,
    lastSeenPlayer: 0,
    outOfRangeSince: null,
    targetId: null,
    
    // Timers
    cooldownUntil: 0,
    moveCooldown: 0,
    nextAttackAt: 0,
    lastAggroAt: 0,
    lastDamagedAt: 0,
    lastRegenTick: 0,
    
    // Breakoff / retreat state
    brokenOffUntil: 0,
    retreatReason: null,
    retreatStartedAt: null,
    retreatStuckSince: null,
    
    // Spawn protection - prevents spawn camping
    spawnedAt: t,
    spawnImmunityUntil: t + AI.SPAWN_IMMUNITY_MS,
    
    // Flags
    isStray: request.metadata.isStray,
    isNpeCritter: request.metadata.isNpeCritter,
    isSoloCritter: request.metadata.isNpeCritter,
    
    // Effects (status effects system)
    effects: {
      stunUntil: 0,
      rootUntil: 0,
      slowUntil: 0,
      slowMult: 1,
      vulnUntil: 0,
      vulnMult: 1,
      immuneUntil: 0
    }
  };
  
  // Apply alpha modifications ONCE at spawn (stats only, no combat multipliers)
  if (rosterEntry.isAlpha) {
    applyAlphaMods(enemy);
  }
  
  // Ensure health keys are normalized and HP is clamped
  normalizeHealthKeys(enemy);
  clampHP(enemy);
  
  return enemy;
}

// ============================================
// ENEMY DEATH CALLBACK
// ============================================
export function onEnemyDeath(enemy) {
  // Release reserved tiles
  if (enemy.reservedTiles && Array.isArray(enemy.reservedTiles)) {
    releaseBlock(enemy.reservedTiles);
  }
  
  // Update spawner alive count
  const spawner = spawners.find(s => s.id === enemy.spawnerId);
  if (spawner) {
    spawner.aliveCount = Math.max(0, spawner.aliveCount - 1);
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function getRingForDistance(dist) {
  if (dist <= RINGS.safe.max) return 'safe';
  if (dist <= RINGS.frontier.max) return 'frontier';
  if (dist <= RINGS.wilderness.max) return 'wilderness';
  return 'danger';
}

function isInsideBaseBounds(x, y) {
  if (!baseBounds) return false;
  const buffer = baseBuffer;
  return x >= baseBounds.minX - buffer && 
         x <= baseBounds.maxX + buffer &&
         y >= baseBounds.minY - buffer &&
         y <= baseBounds.maxY + buffer;
}

// ============================================
// DEBUG & EXPORTS
// ============================================
export function getSpawnDebugInfo() {
  const player = currentState?.player;
  if (!player) return null;
  
  const playerDistFromBase = distCoords(player.x, player.y, baseCenter.x, baseCenter.y);
  const bubble = getActiveBubble(player);
  const counts = countEnemiesInBubble(bubble);
  
  return {
    playerRing: getRingForDistance(playerDistFromBase),
    playerDistFromBase: Math.round(playerDistFromBase),
    baseCenter,
    baseBounds,
    activeBubble: bubble,
    counts,
    spawnerCount: spawners.length,
    eligibleSpawners: spawners.filter(s => isSpawnerEligible(s, nowMs(), counts)).length
  };
}

export function getSpawners() {
  return spawners;
}

export function getBaseCenter() {
  return baseCenter;
}

export function getRings() {
  return RINGS;
}

export function getEnemyTypes() {
  return ENEMY_TYPES;
}

// ============================================
// DEBUG HELPERS
// ============================================

/**
 * Debug: List all active enemies with their spawn positions and pack info.
 * Call from console: VETUU_SPAWNS()
 */
function debugListSpawns() {
  if (!currentState) {
    console.log('[VETUU_SPAWNS] No state available');
    return [];
  }
  
  const enemies = currentState.runtime.activeEnemies || [];
  const result = enemies
    .filter(e => e.hp > 0)
    .map(e => ({
      id: e.id,
      name: e.name,
      level: e.level,
      position: { x: e.x, y: e.y },
      spawnPoint: { x: e.spawnX, y: e.spawnY },
      home: e.home,
      packId: e.packId || null,
      packHomeCenter: e.packHomeCenter || null,
      isRetreating: e.isRetreating,
      reservedTileCount: e.reservedTiles?.length || 0
    }));
  
  console.table(result);
  return result;
}

/**
 * Debug: Count reserved tiles and optionally highlight them.
 * Call from console: VETUU_RESERVED() or VETUU_RESERVED(true) to highlight
 */
function debugReservedTiles(highlight = false) {
  const count = reservedTiles.size;
  const tiles = Array.from(reservedTiles).map(key => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  });
  
  console.log(`[VETUU_RESERVED] ${count} tiles reserved`);
  
  if (highlight && count > 0) {
    // Add visual markers to the map
    const actorLayer = document.getElementById('actor-layer');
    if (actorLayer) {
      // Remove existing debug markers
      actorLayer.querySelectorAll('.debug-reserved-tile').forEach(el => el.remove());
      
      for (const tile of tiles) {
        const marker = document.createElement('div');
        marker.className = 'debug-reserved-tile';
        marker.style.cssText = `
          position: absolute;
          left: ${tile.x * 24}px;
          top: ${tile.y * 24}px;
          width: 24px;
          height: 24px;
          background: rgba(255, 0, 0, 0.2);
          border: 1px solid rgba(255, 0, 0, 0.5);
          pointer-events: none;
          z-index: 5;
        `;
        actorLayer.appendChild(marker);
      }
      console.log(`[VETUU_RESERVED] Added ${count} visual markers (call VETUU_RESERVED_CLEAR() to remove)`);
    }
  }
  
  return { count, tiles };
}

/**
 * Debug: Clear reserved tile visual markers.
 */
function debugClearReservedMarkers() {
  const actorLayer = document.getElementById('actor-layer');
  if (actorLayer) {
    actorLayer.querySelectorAll('.debug-reserved-tile').forEach(el => el.remove());
    console.log('[VETUU_RESERVED_CLEAR] Markers removed');
  }
}

// Expose debug functions to window
if (typeof window !== 'undefined') {
  window.VETUU_SPAWNS = debugListSpawns;
  window.VETUU_RESERVED = debugReservedTiles;
  window.VETUU_RESERVED_CLEAR = debugClearReservedMarkers;
}

export { ENEMY_TYPES, RINGS };

