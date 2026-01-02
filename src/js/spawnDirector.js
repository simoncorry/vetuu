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
import { renderEnemies } from './combat.js';

// ============================================
// CONSTANTS - DISTANCE RINGS
// ============================================
// World scale: Map is 480×320 (4x original), base at center (~240, 160)
// Max radius from center to corner: ~288 tiles
// Rings define difficulty zones based on distance from base
//
// Design goals:
// - Safe: Calm NPE zone, enough space to learn (20-40s walk before real danger)
// - Frontier: Mixed threats, early packs, levels 4-12
// - Wilderness: Trog territory, real danger, levels 12-25
// - Danger: Karth patrols, elite content, levels 25-40
// - Deep: Endgame area, levels 40-50, low density high lethality
const RINGS = {
  safe:       { min: 0,  max: 28 },    // Wide calm zone around Drycross
  frontier:   { min: 29, max: 70 },    // Mixed threats, early packs
  wilderness: { min: 71, max: 125 },   // Trog territory, real danger
  danger:     { min: 126, max: 190 },  // Karth patrols, elites
  deep:       { min: 191, max: Infinity } // Optional endgame spawns
};

// ============================================
// CONSTANTS - DENSITY & SPAWNING
// ============================================
const ACTIVE_RADIUS = 30;           // Bubble around player for spawn decisions (wider for larger world)
const NO_SPAWN_RADIUS = 12;         // Don't spawn within this range of player
const SPAWN_TICK_MS = 500;          // How often to check spawns

// Density caps within active bubble
// Lower density = longer travel between fights = quest XP matters more
const MAX_STRAYS = 5;               // Reduced from 6
const MAX_PACKS = 2;
const MAX_TOTAL_ENEMIES = 10;       // Reduced from 12 - less crowded

// NPE (New Player Experience) critter guarantees
const NPE_CRITTER_MIN = 2;
const NPE_CRITTER_ZONE_MIN = 10;    // Min distance from base for NPE critters (wider safe zone)
const NPE_CRITTER_ZONE_MAX = 24;    // Max distance from base for NPE critters (matches new safe ring)

// Respawn timing (longer = more exploration feel)
// Safe/Frontier: slower respawns so it doesn't feel like a shooting gallery
// Wilderness/Danger: longer but packs are scarier
const STRAY_RESPAWN_MS = { min: 120000, max: 240000 };   // 2-4 min (was 1.5-3)
const PACK_RESPAWN_MS = { min: 300000, max: 600000 };    // 5-10 min (was 4-10)

// ============================================
// CONSTANTS - RING SPAWN WEIGHTS
// ============================================
// Controls the balance of solo enemies vs packs per ring
// Safe ring: ALWAYS solo (pack weight 0) - guaranteed by guardrails too
const RING_WEIGHTS = {
  safe:       { stray: 1.0, pack: 0.0 },  // Solo only
  frontier:   { stray: 0.4, pack: 0.6 },  // Mixed, leaning toward packs
  wilderness: { stray: 0.2, pack: 0.8 },  // Mostly packs
  danger:     { stray: 0.1, pack: 0.9 },  // Almost all packs
  deep:       { stray: 0.1, pack: 0.9 }   // Almost all packs, high lethality
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
// SLOT-BASED TILE RESERVATION SYSTEM
// ============================================
// Tiles are now owned by spawner SLOTS, not individual enemies.
// This is the key insight: reservations are permanent for the spawner's lifetime,
// not released on enemy death. This prevents pack clumping over time.
//
// Key format: "x,y" -> { spawnerId, slotIndex }
const reservedBy = new Map();

/**
 * Check if a tile is reserved by any slot.
 */
function isReserved(x, y) {
  return reservedBy.has(`${x},${y}`);
}

/**
 * Get the owner of a reserved tile.
 * @returns {{ spawnerId: string, slotIndex: number } | null}
 */
function getReservationOwner(x, y) {
  return reservedBy.get(`${x},${y}`) || null;
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
 * Reserve all tiles in a block for a specific slot.
 * @param {Array<{x: number, y: number}>} tiles - Tiles to reserve
 * @param {string} spawnerId - ID of the spawner that owns this slot
 * @param {number} slotIndex - Index of the slot within the spawner
 */
function reserveBlockForSlot(tiles, spawnerId, slotIndex) {
  for (const tile of tiles) {
    reservedBy.set(`${tile.x},${tile.y}`, { spawnerId, slotIndex });
  }
}

/**
 * Release all tiles in a block (only when spawner is disabled/deleted).
 * NOT called on enemy death - slots own their footprints permanently.
 * @param {Array<{x: number, y: number}>} tiles - Tiles to release
 */
function releaseSlotBlock(tiles) {
  for (const tile of tiles) {
    reservedBy.delete(`${tile.x},${tile.y}`);
  }
}

/**
 * LEGACY: Release enemy's reserved block when they die or despawn.
 * NOTE: In slot-based spawning, this is a NO-OP for slot-spawned enemies.
 * The slot owns the reservation, not the enemy.
 */
export function releaseEnemyBlock(enemy) {
  // Slot-based enemies don't release their blocks on death
  // The slot maintains the reservation until the spawner is disabled
  // This prevents pack clumping over time
  
  // Only release for non-slot enemies (legacy spawns, if any)
  if (!enemy.slotIndex && enemy.reservedTiles && Array.isArray(enemy.reservedTiles)) {
    for (const tile of enemy.reservedTiles) {
      reservedBy.delete(`${tile.x},${tile.y}`);
    }
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
// LOADED REGION MODEL
// ============================================
// Controls which spawners are active (to avoid simulating the whole planet)
const BASE_BUBBLE_RADIUS = 50;      // Always keep base area populated
const PLAYER_BUBBLE_MARGIN = 15;    // Extra margin beyond ACTIVE_RADIUS

/**
 * Check if a spawner is in a "loaded" region (base bubble or player bubble).
 */
function isSpawnerInLoadedRegion(spawner) {
  const player = currentState?.player;
  if (!player) return false;
  
  const distFromBase = distCoords(spawner.center.x, spawner.center.y, baseCenter.x, baseCenter.y);
  const distFromPlayer = distCoords(spawner.center.x, spawner.center.y, player.x, player.y);
  
  // In base bubble (always active)
  if (distFromBase <= BASE_BUBBLE_RADIUS) return true;
  
  // In player bubble (active when player is nearby)
  if (distFromPlayer <= ACTIVE_RADIUS + PLAYER_BUBBLE_MARGIN) return true;
  
  return false;
}

// ============================================
// INITIALIZATION
// ============================================
export function initSpawnDirector(state) {
  currentState = state;
  
  // Set base center from map offset
  if (state.map?.meta?.originalOffset) {
    const ox = state.map.meta.originalOffset.x;
    const oy = state.map.meta.originalOffset.y;
    // Base center (4x scaled base, centered at 56,38)
    baseCenter = { x: 56 + ox, y: 38 + oy };
    
    // Define base bounds (4x scaled: 33,21 → 79,55)
    baseBounds = {
      minX: 22 + ox,
      maxX: 90 + ox,
      minY: 13 + oy,
      maxY: 63 + oy
    };
  }
  
  // Clear any existing reservations
  reservedBy.clear();
  
  // Initialize spawners with slot schema
  initializeSpawners(state);
  
  // BOOTSTRAP: Fill spawner slots immediately so world feels populated
  bootstrapSpawns();
  
  // Start spawn tick (now checks slot timers instead of random picking)
  if (spawnTickInterval) clearInterval(spawnTickInterval);
  spawnTickInterval = setInterval(() => spawnDirectorTick(), SPAWN_TICK_MS);
  
  // Log summary
  const totalSlots = spawners.reduce((sum, s) => sum + s.slots.length, 0);
  const validSlots = spawners.reduce((sum, s) => sum + s.slots.filter(sl => sl.spawnX !== null).length, 0);
  console.log(`[SpawnDirector] Initialized with ${spawners.length} spawners, ${validSlots}/${totalSlots} valid slots`);
  console.log(`[SpawnDirector] Base center: (${baseCenter.x}, ${baseCenter.y}), Player at: (${currentState.player.x}, ${currentState.player.y})`);
}

function initializeSpawners(state) {
  spawners = [];
  
  // Generate spawner definitions
  const spawnerDefs = state.spawnerDefs || generateDefaultSpawners();
  
  // Convert each spawner to slot-based schema
  for (const def of spawnerDefs) {
    const spawner = {
      ...def,
      // Slot-based schema
      slots: [],
      // Legacy fields (for compatibility)
      lastSpawnAt: -Infinity,
      aliveCount: 0
    };
    
    // Initialize slots for this spawner
    initializeSpawnerSlots(spawner);
    
    spawners.push(spawner);
  }
}

/**
 * Initialize slots for a spawner with permanent footprint reservations.
 * For strays: 1 slot
 * For packs: MAX_PACK_SIZE slots (so packs can grow to full size)
 */
function initializeSpawnerSlots(spawner) {
  const slotCount = spawner.kind === 'pack' 
    ? (spawner.packSize?.max ?? MAX_PACK_SIZE) 
    : 1;
  
  // Find positions for all slots upfront
  const positions = findSlotPositions(spawner, slotCount);
  
  if (positions.length === 0 && slotCount > 0) {
    // Debug: log when a spawner fails to find ANY valid positions
    console.warn(`[SpawnDirector] Spawner ${spawner.id} at (${spawner.center.x}, ${spawner.center.y}) found 0/${slotCount} positions`);
  }
  
  for (let i = 0; i < slotCount; i++) {
    const position = positions[i] || null;
    
    const slot = {
      index: i,
      // Permanent footprint (reserved once, never released until spawner disabled)
      reservedTiles: position?.blockTiles || [],
      spawnX: position?.x ?? null,
      spawnY: position?.y ?? null,
      // Slot state
      aliveEnemyId: null,      // Enemy ID occupying this slot (null = empty)
      nextRespawnAt: -Infinity, // When slot can respawn (-Infinity = ready)
      lastSpawnAt: -Infinity
    };
    
    // Reserve tiles for this slot permanently
    if (slot.reservedTiles.length > 0) {
      reserveBlockForSlot(slot.reservedTiles, spawner.id, i);
    }
    
    spawner.slots.push(slot);
  }
}

/**
 * Find permanent positions for spawner slots.
 * These positions are calculated once and owned forever.
 */
function findSlotPositions(spawner, count) {
  const positions = [];
  
  if (count === 1) {
    // Single slot: find one block near spawner center
    const block = findFreeBlockForSlot(spawner);
    if (block) {
      positions.push({
        x: block.centerX,
        y: block.centerY,
        blockTiles: block.tiles
      });
    }
    return positions;
  }
  
  // Multiple slots: arrange in a grid layout
  const gridPositions = findSlotGridLayout(spawner, count);
  return gridPositions || [];
}

/**
 * Bootstrap: Fill spawner slots immediately on world load.
 * This makes the world feel populated from the start, not "streaming in."
 */
function bootstrapSpawns() {
  const now = nowMs();
  
  // Get spawners in loaded regions
  const loadedSpawners = spawners.filter(s => isSpawnerInLoadedRegion(s));
  
  console.log(`[SpawnDirector] Bootstrapping ${loadedSpawners.length} spawners in loaded regions...`);
  
  let spawnedCount = 0;
  let skippedNoSlots = 0;
  let skippedFlag = 0;
  
  for (const spawner of loadedSpawners) {
    // Check requirements (e.g., Act 3)
    if (spawner.requires?.flag && !hasFlag(spawner.requires.flag)) {
      skippedFlag++;
      continue;
    }
    
    // Check if spawner has valid slots
    const validSlots = spawner.slots.filter(s => s.spawnX !== null);
    if (validSlots.length === 0) {
      skippedNoSlots++;
      continue;
    }
    
    // Fill slots
    const filled = fillSpawnerSlots(spawner, now, { immediate: true });
    spawnedCount += filled;
  }
  
  console.log(`[SpawnDirector] Bootstrap complete: ${spawnedCount} enemies spawned`);
  console.log(`[SpawnDirector] Skipped: ${skippedNoSlots} no valid slots, ${skippedFlag} flag requirements`);
  console.log(`[SpawnDirector] Active enemies: ${currentState.runtime.activeEnemies.length}`);
  
  // NOTE: Rendering happens synchronously in game.js after initSpawnDirector returns.
  // No async import needed here - enemies are already in state.runtime.activeEnemies.
}

// ============================================
// DEFAULT SPAWNER GENERATION
// ============================================
// Ring-based spawn distribution for level 50 progression:
// - SAFE (0-28): Solo nomads, levels 1-3, NPE zone
// - FRONTIER (29-70): Solo critters + scav packs, levels 4-12
// - WILDERNESS (71-125): Trog packs, levels 12-25
// - DANGER (126-190): Karth packs, levels 25-40
// - DEEP (191+): Endgame packs, levels 40-50 (optional)
function generateDefaultSpawners() {
  const result = [];
  let id = 0;
  
  // ============================================
  // SAFE RING: NOMADS ONLY (Solo, Level 1-3)
  // ============================================
  // NPE zone: passive wanderers, high spacing, low density
  // 25-35 spawners spread across the safe ring
  
  // Inner nomads (level 1, closest to base)
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const dist = 8 + Math.random() * 4; // 8-12 tiles from center
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
      levelRange: [1, 1],
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
  
  // Mid nomads (level 1-2, middle of safe zone)
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2 + Math.PI / 20;
    const dist = 14 + Math.random() * 5; // 14-19 tiles from center
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
      levelRange: [1, 2],
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
  
  // Outer nomads (level 2-3, edge of safe zone)
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 16;
    const dist = 21 + Math.random() * 6; // 21-27 tiles from center
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
      levelRange: [2, 3],
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
  // FRONTIER RING: SCAVS (Mix solo + packs, Level 4-12)
  // ============================================
  // Transition zone: first packs appear, levels 4-12
  // 15-20 spawners
  
  // Frontier solo strays (level 4-6)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dist = 32 + Math.random() * 8; // 32-40 tiles from center
    result.push({
      id: `sp_frontier_stray_${id++}`,
      kind: 'stray',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 5,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['nomad', 'scav_melee'],
      levelRange: [4, 6],
      aggroType: 'conditional',
      aggroRadius: 5,
      leashRadius: 12,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0
    });
  }
  
  // Inner frontier packs (level 4-7, small packs)
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + Math.PI / 10;
    const dist = 35 + Math.random() * 8; // 35-43 tiles from center
    result.push({
      id: `sp_pack_frontier_inner_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 6,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_ranged', 'scav_melee'],
      levelRange: [4, 7],
      packSize: { min: 2, max: 4 },
      alpha: { chance: 0.15, max: 1 },
      aggroType: 'conditional',
      aggroRadius: 6,
      leashRadius: 14,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 16
    });
  }
  
  // Mid frontier packs (level 7-10)
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const dist = 48 + Math.random() * 10; // 48-58 tiles from center
    result.push({
      id: `sp_pack_frontier_mid_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 7,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_ranged', 'scav_melee'],
      levelRange: [7, 10],
      packSize: { min: 3, max: 5 },
      alpha: { chance: 0.25, max: 1 },
      aggroType: 'conditional',
      aggroRadius: 6,
      leashRadius: 16,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 16
    });
  }
  
  // Outer frontier packs (level 10-12, larger packs)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const dist = 60 + Math.random() * 8; // 60-68 tiles from center
    result.push({
      id: `sp_pack_frontier_outer_${id++}`,
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
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.3, max: 1 },
      aggroType: 'aggressive',
      aggroRadius: 7,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 18
    });
  }
  
  // ============================================
  // WILDERNESS RING: TROGS (Packs, Level 12-25)
  // ============================================
  // Real danger zone: trog warbands, levels 12-25
  // 10-14 spawners
  
  // Inner wilderness (level 12-16)
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const dist = 78 + Math.random() * 12; // 78-90 tiles from center
    result.push({
      id: `sp_pack_trog_inner_${id++}`,
      kind: 'pack',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 8,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['trog_warrior', 'trog_shaman'],
      levelRange: [12, 16],
      packSize: { min: 3, max: 5 },
      alpha: { chance: 0.35, max: 1 },
      aggroType: 'aggressive',
      aggroRadius: 8,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 18
    });
  }
  
  // Mid wilderness (level 16-20)
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const dist = 95 + Math.random() * 15; // 95-110 tiles from center
    result.push({
      id: `sp_pack_trog_mid_${id++}`,
      kind: 'pack',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 9,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['trog_warrior', 'trog_shaman'],
      levelRange: [16, 20],
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.4, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 9,
      leashRadius: 20,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 20
    });
  }
  
  // Outer wilderness (level 20-25)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const dist = 112 + Math.random() * 12; // 112-124 tiles from center
    result.push({
      id: `sp_pack_trog_outer_${id++}`,
      kind: 'pack',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 10,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['trog_warrior', 'trog_shaman'],
      levelRange: [20, 25],
      packSize: { min: 5, max: 7 },
      alpha: { chance: 0.45, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 10,
      leashRadius: 22,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 22
    });
  }
  
  // ============================================
  // DANGER RING: KARTH (Packs, Level 25-40)
  // ============================================
  // Elite zone: Karth Directorate patrols, levels 25-40
  // 8-12 spawners, requires Act 3
  
  // Inner danger (level 25-30)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const dist = 132 + Math.random() * 15; // 132-147 tiles from center
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
      levelRange: [25, 30],
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.4, max: 1 },
      aggroType: 'aggressive',
      aggroRadius: 10,
      leashRadius: 22,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 22,
      requires: { flag: 'act3' }
    });
  }
  
  // Mid danger (level 30-35)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dist = 155 + Math.random() * 18; // 155-173 tiles from center
    result.push({
      id: `sp_pack_karth_mid_${id++}`,
      kind: 'pack',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 12,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [30, 35],
      packSize: { min: 5, max: 7 },
      alpha: { chance: 0.5, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 12,
      leashRadius: 24,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 24,
      requires: { flag: 'act3' }
    });
  }
  
  // Outer danger (level 35-40)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const dist = 178 + Math.random() * 10; // 178-188 tiles from center
    result.push({
      id: `sp_pack_karth_outer_${id++}`,
      kind: 'pack',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 12,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [35, 40],
      packSize: { min: 5, max: 8 },
      alpha: { chance: 0.55, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 12,
      leashRadius: 24,
      deaggroTimeMs: 7000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 24,
      requires: { flag: 'act3' }
    });
  }
  
  // ============================================
  // DEEP RING: ENDGAME (Packs, Level 40-50)
  // ============================================
  // Optional endgame area: levels 40-50, low density, high lethality
  // 4-8 spawners, requires Act 3
  // NOTE: Most of deep ring is near/beyond map edges (191+ tiles)
  // Only a few spawners in accessible areas near the corners
  
  // Deep zone spawners (level 40-45) - positioned in corners
  const deepAngles = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4]; // Corner angles
  for (let i = 0; i < 4; i++) {
    const angle = deepAngles[i];
    const dist = 180 + Math.random() * 15; // Near edge of danger ring
    result.push({
      id: `sp_pack_deep_${id++}`,
      kind: 'pack',
      ring: 'deep',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 12,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [40, 45],
      packSize: { min: 4, max: 6 },
      alpha: { chance: 0.6, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 14,
      leashRadius: 26,
      deaggroTimeMs: 8000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min * 1.5, PACK_RESPAWN_MS.max * 1.5),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 26,
      requires: { flag: 'act3' }
    });
  }
  
  // Elite deep spawners (level 45-50) - very rare, corner positions
  for (let i = 0; i < 2; i++) {
    const angle = deepAngles[i * 2]; // Only 2 spawners at opposite corners
    const dist = 190 + Math.random() * 10;
    result.push({
      id: `sp_pack_deep_elite_${id++}`,
      kind: 'pack',
      ring: 'deep',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 14,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [45, 50],
      packSize: { min: 5, max: 8 },
      alpha: { chance: 0.7, max: 3 },
      aggroType: 'aggressive',
      aggroRadius: 15,
      leashRadius: 28,
      deaggroTimeMs: 10000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min * 2, PACK_RESPAWN_MS.max * 2),
      maxAlive: 1,
      lastSpawnAt: -Infinity,
      aliveCount: 0,
      minDistanceToOtherPacks: 30,
      requires: { flag: 'act3' }
    });
  }
  
  return result;
}

// ============================================
// SLOT FILLING LOGIC
// ============================================

/**
 * Fill available slots in a spawner.
 * For packs: fills all slots at once when pack spawns
 * For strays: fills single slot
 * 
 * @param {object} spawner - The spawner to fill
 * @param {number} now - Current timestamp
 * @param {object} options - { immediate: boolean } - Skip respawn timer check
 * @returns {number} Number of enemies spawned
 */
function fillSpawnerSlots(spawner, now, options = {}) {
  const { immediate = false } = options;
  
  // For packs: determine pack size and spawn as a group
  if (spawner.kind === 'pack') {
    return fillPackSlots(spawner, now, immediate);
  }
  
  // For strays: fill single slot
  return fillStraySlot(spawner, now, immediate);
}

/**
 * Fill slots for a stray (solo) spawner.
 */
function fillStraySlot(spawner, now, immediate) {
  const slot = spawner.slots[0];
  if (!slot || !slot.spawnX) return 0;
  
  // Check if slot is occupied
  if (slot.aliveEnemyId) return 0;
  
  // Check respawn timer (unless immediate)
  if (!immediate && now < slot.nextRespawnAt) return 0;
  
  // Check player distance (skip during bootstrap - we WANT a populated world on load)
  // During bootstrap, only block spawning ON the player (2 tiles)
  const player = currentState.player;
  const minDist = immediate ? 2 : NO_SPAWN_RADIUS;
  if (distCoords(slot.spawnX, slot.spawnY, player.x, player.y) < minDist) return 0;
  
  // Spawn enemy
  const enemy = spawnEnemyInSlot(spawner, slot, now);
  if (!enemy) return 0;
  
  // Update slot state
  slot.aliveEnemyId = enemy.id;
  slot.lastSpawnAt = now;
  spawner.aliveCount++;
  
  return 1;
}

/**
 * Fill slots for a pack spawner.
 * Packs spawn as a group - all slots filled at once.
 */
function fillPackSlots(spawner, now, immediate) {
  // Check if any pack members are alive (pack respawns when ALL dead)
  const anyAlive = spawner.slots.some(s => s.aliveEnemyId !== null);
  if (anyAlive) return 0;
  
  // Check respawn timer on first slot (pack timer)
  const firstSlot = spawner.slots[0];
  if (!immediate && firstSlot && now < firstSlot.nextRespawnAt) return 0;
  
  // Determine pack size for this spawn
  const packSize = randomRange(
    spawner.packSize?.min ?? MIN_PACK_SIZE,
    Math.min(spawner.packSize?.max ?? MAX_PACK_SIZE, spawner.slots.filter(s => s.spawnX).length)
  );
  
  // Get valid slots (have positions)
  const validSlots = spawner.slots.filter(s => s.spawnX !== null);
  if (validSlots.length < packSize) return 0;
  
  // Shuffle slots for variety in which positions get used
  const shuffledSlots = [...validSlots].sort(() => Math.random() - 0.5);
  const slotsToUse = shuffledSlots.slice(0, packSize);
  
  // Check player distance from pack center (skip during bootstrap - we WANT a populated world)
  // During bootstrap, only block spawning ON the player (2 tiles)
  const player = currentState.player;
  const avgX = slotsToUse.reduce((sum, s) => sum + s.spawnX, 0) / slotsToUse.length;
  const avgY = slotsToUse.reduce((sum, s) => sum + s.spawnY, 0) / slotsToUse.length;
  const minDist = immediate ? 2 : NO_SPAWN_RADIUS;
  if (distCoords(avgX, avgY, player.x, player.y) < minDist) return 0;
  
  // Generate pack ID
  const packId = `pack_${Math.floor(now)}_${Math.random().toString(36).substr(2, 5)}`;
  
  // Determine alphas
  let alphaSlots = 0;
  if (spawner.alpha) {
    for (let i = 0; i < packSize && alphaSlots < spawner.alpha.max; i++) {
      if (Math.random() < spawner.alpha.chance) alphaSlots++;
    }
  }
  
  // Spawn enemies in slots
  let spawnedCount = 0;
  for (let i = 0; i < slotsToUse.length; i++) {
    const slot = slotsToUse[i];
    const isAlpha = i < alphaSlots;
    
    const enemy = spawnEnemyInSlot(spawner, slot, now, { packId, isAlpha });
    if (enemy) {
      slot.aliveEnemyId = enemy.id;
      slot.lastSpawnAt = now;
      spawnedCount++;
    }
  }
  
  spawner.aliveCount = spawnedCount;
  
  return spawnedCount;
}

/**
 * Spawn a single enemy in a slot.
 */
function spawnEnemyInSlot(spawner, slot, now, options = {}) {
  const { packId = null, isAlpha = false } = options;
  
  // Pick enemy type and level
  const enemyType = spawner.enemyPool[Math.floor(Math.random() * spawner.enemyPool.length)];
  const level = randomRange(spawner.levelRange[0], spawner.levelRange[1]);
  
  // Create the enemy
  const enemy = createEnemyFromSlot(spawner, slot, {
    type: enemyType,
    level,
    isAlpha,
    packId
  }, now);
  
  // Add to active enemies
  currentState.runtime.activeEnemies.push(enemy);
  
  return enemy;
}

/**
 * Create enemy entity from slot data.
 */
function createEnemyFromSlot(spawner, slot, rosterEntry, t) {
  const typeDef = ENEMY_TYPES[rosterEntry.type] || ENEMY_TYPES.nomad;
  const level = rosterEntry.level;
  
  // Calculate stats with level scaling
  const hpScale = Math.pow(1.02, level - 1);
  const atkScale = Math.pow(1.017, level - 1);
  const defScale = Math.pow(1.014, level - 1);
  
  const hp = Math.floor(typeDef.baseHp * hpScale);
  const atk = Math.floor(typeDef.baseAtk * atkScale);
  const def = Math.floor(typeDef.baseDef * defScale);
  
  const enemy = {
    id: `enemy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: typeDef.name,
    type: rosterEntry.type,
    level,
    
    // Position from slot (authoritative)
    x: slot.spawnX,
    y: slot.spawnY,
    spawnX: slot.spawnX,
    spawnY: slot.spawnY,
    
    // Slot ownership
    spawnerId: spawner.id,
    slotIndex: slot.index,
    
    // Reserved tiles (reference to slot's permanent reservation)
    reservedTiles: slot.reservedTiles,
    
    // Stats
    hp,
    maxHp: hp,
    maxHP: hp,
    atk,
    def,
    
    // Visual
    color: typeDef.color,
    combatType: typeDef.combatType,
    weapon: typeDef.weapon,
    projectileColor: typeDef.projectileColor,
    moveSpeed: typeDef.moveSpeed,
    
    // AI behavior
    aggroType: spawner.aggroType || typeDef.defaultAggroType,
    aggroRadius: spawner.aggroRadius || typeDef.defaultAggroRadius,
    leashRadius: spawner.leashRadius || typeDef.defaultLeashRadius,
    deaggroTimeMs: spawner.deaggroTimeMs || typeDef.defaultDeaggroMs,
    
    // Home point (per-enemy, for retreat)
    home: { x: slot.spawnX, y: slot.spawnY },
    
    // Pack info
    packId: rosterEntry.packId || null,
    
    // Flags
    isNpeCritter: spawner.isNpeCritter || false,
    isSoloCritter: spawner.kind === 'stray',
    isStray: spawner.kind === 'stray',
    
    // Spawn timing
    spawnedAt: t,
    spawnImmunityUntil: t + AI.SPAWN_IMMUNITY_MS,
    
    // Combat state (initialized by combat.js)
    state: AI.STATES.UNAWARE,
    targetId: null,
    isEngaged: false,
    isAware: false,
    isRetreating: false,
    nextAttackAt: 0,
    moveCooldown: 0
  };
  
  // Apply alpha modifications
  if (rosterEntry.isAlpha) {
    applyAlphaMods(enemy);
  }
  
  // Normalize health keys
  normalizeHealthKeys(enemy);
  clampHP(enemy);
  
  return enemy;
}

// ============================================
// MAIN SPAWN TICK (Slot-Timer Based)
// ============================================
function spawnDirectorTick() {
  if (!currentState) return;
  
  const now = nowMs();
  const player = currentState.player;
  
  // Don't spawn while ghost running
  if (document.getElementById('player')?.classList.contains('ghost')) return;
  
  // Get spawners in loaded regions
  const loadedSpawners = spawners.filter(s => isSpawnerInLoadedRegion(s));
  
  let anySpawned = false;
  
  // Check each spawner's slots for respawn
  for (const spawner of loadedSpawners) {
    // Check requirements (e.g., Act 3)
    if (spawner.requires?.flag && !hasFlag(spawner.requires.flag)) continue;
    
    // For packs: check if pack can respawn (all members dead + timer)
    if (spawner.kind === 'pack') {
      const anyAlive = spawner.slots.some(s => s.aliveEnemyId !== null);
      if (anyAlive) continue;
      
      const firstSlot = spawner.slots[0];
      if (firstSlot && now >= firstSlot.nextRespawnAt) {
        const filled = fillPackSlots(spawner, now, false);
        if (filled > 0) anySpawned = true;
      }
    } else {
      // For strays: check individual slot
      const slot = spawner.slots[0];
      if (slot && !slot.aliveEnemyId && now >= slot.nextRespawnAt) {
        const filled = fillStraySlot(spawner, now, false);
        if (filled > 0) anySpawned = true;
      }
    }
  }
  
  // Render new enemies if any spawned
  if (anySpawned) {
    renderEnemies(currentState);
  }
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

// ============================================
// SLOT POSITION FINDING (for initialization)
// ============================================

/**
 * Find a free block for slot initialization.
 * Similar to findFreeBlock but doesn't check player distance (slots are permanent).
 */
function findFreeBlockForSlot(spawner) {
  const maxSearchRadius = Math.max(spawner.spawnRadius, 10);
  
  // Spiral search from spawner center
  for (let radius = 0; radius <= maxSearchRadius; radius++) {
    const candidates = [];
    
    if (radius === 0) {
      candidates.push({ x: spawner.center.x, y: spawner.center.y });
    } else {
      for (let i = -radius; i <= radius; i++) {
        candidates.push({ x: spawner.center.x + i, y: spawner.center.y - radius });
        candidates.push({ x: spawner.center.x + i, y: spawner.center.y + radius });
        if (Math.abs(i) !== radius) {
          candidates.push({ x: spawner.center.x - radius, y: spawner.center.y + i });
          candidates.push({ x: spawner.center.x + radius, y: spawner.center.y + i });
        }
      }
    }
    
    // Shuffle for variety
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    
    for (const candidate of candidates) {
      const cx = candidate.x;
      const cy = candidate.y;
      
      // Check if block is valid (walkable, not already reserved, not in base)
      if (!isBlockValidForSlot(cx, cy)) continue;
      
      return { centerX: cx, centerY: cy, tiles: getBlockTiles(cx, cy) };
    }
  }
  
  return null;
}

/**
 * Check if a block is valid for slot reservation.
 * Doesn't check player distance (slots are permanent).
 */
function isBlockValidForSlot(cx, cy) {
  const tiles = getBlockTiles(cx, cy);
  
  for (const tile of tiles) {
    // Walkability
    if (!canMoveTo(currentState, tile.x, tile.y)) return false;
    // Not already reserved by another slot
    if (isReserved(tile.x, tile.y)) return false;
    // Not in base bounds
    if (isInsideBaseBounds(tile.x, tile.y)) return false;
  }
  
  return true;
}

/**
 * Find grid layout positions for multiple slots (packs).
 */
function findSlotGridLayout(spawner, count) {
  const maxAnchorAttempts = 30;
  
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const layoutWidth = cols * BLOCK_STRIDE;
  const layoutHeight = rows * BLOCK_STRIDE;
  
  for (let attempt = 0; attempt < maxAnchorAttempts; attempt++) {
    let anchorX, anchorY;
    
    if (attempt === 0) {
      anchorX = spawner.center.x - Math.floor(layoutWidth / 2);
      anchorY = spawner.center.y - Math.floor(layoutHeight / 2);
    } else {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spawner.spawnRadius;
      anchorX = Math.round(spawner.center.x + Math.cos(angle) * dist) - Math.floor(layoutWidth / 2);
      anchorY = Math.round(spawner.center.y + Math.sin(angle) * dist) - Math.floor(layoutHeight / 2);
    }
    
    const positions = [];
    let allValid = true;
    let blockIndex = 0;
    
    for (let row = 0; row < rows && allValid; row++) {
      for (let col = 0; col < cols && allValid; col++) {
        if (blockIndex >= count) break;
        
        const cx = anchorX + col * BLOCK_STRIDE + Math.floor(BLOCK_SIZE / 2);
        const cy = anchorY + row * BLOCK_STRIDE + Math.floor(BLOCK_SIZE / 2);
        
        if (!isBlockValidForSlot(cx, cy)) {
          allValid = false;
          break;
        }
        
        const tiles = getBlockTiles(cx, cy);
        
        // Check no overlap with positions already picked
        const overlaps = positions.some(pos =>
          pos.blockTiles.some(pt => tiles.some(t => t.x === pt.x && t.y === pt.y))
        );
        if (overlaps) {
          allValid = false;
          break;
        }
        
        positions.push({ x: cx, y: cy, blockTiles: tiles });
        blockIndex++;
      }
    }
    
    if (allValid && positions.length === count) {
      return positions;
    }
  }
  
  // Fallback: find positions individually
  const positions = [];
  const searchRadius = spawner.spawnRadius + 20;
  
  for (let i = 0; i < count; i++) {
    let found = false;
    
    for (let r = 0; r <= searchRadius && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          
          const cx = spawner.center.x + dx;
          const cy = spawner.center.y + dy;
          
          if (!isBlockValidForSlot(cx, cy)) continue;
          
          const tiles = getBlockTiles(cx, cy);
          
          // No overlap with existing positions
          const overlaps = positions.some(pos =>
            pos.blockTiles.some(pt => tiles.some(t => t.x === pt.x && t.y === pt.y))
          );
          if (overlaps) continue;
          
          positions.push({ x: cx, y: cy, blockTiles: tiles });
          found = true;
        }
      }
    }
  }
  
  return positions;
}

// ============================================
// LEGACY POSITION FINDING (for buildSpawnRequest)
// ============================================

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
  renderEnemies(currentState);
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
  // LEVEL CAP 50 SCALING: Gentler curves to prevent stat explosion
  // Using soft power curves instead of linear multipliers
  // At level 50: HP ~2.7x, ATK ~2.3x, DEF ~2.0x base (manageable, not absurd)
  const hpScale = Math.pow(1.02, level - 1);   // ~2.69x at level 50
  const atkScale = Math.pow(1.017, level - 1); // ~2.30x at level 50
  const defScale = Math.pow(1.014, level - 1); // ~1.98x at level 50
  
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
// ENEMY DEATH CALLBACK (Slot-Based)
// ============================================
export function onEnemyDeath(enemy) {
  const now = nowMs();
  
  // Find the spawner and slot
  const spawner = spawners.find(s => s.id === enemy.spawnerId);
  if (!spawner) return;
  
  // Find the slot this enemy occupied
  const slot = spawner.slots.find(s => s.index === enemy.slotIndex);
  if (slot) {
    // Clear slot occupancy
    slot.aliveEnemyId = null;
    
    // For packs: check if entire pack is dead, then start respawn timer
    if (spawner.kind === 'pack') {
      const anyAlive = spawner.slots.some(s => s.aliveEnemyId !== null);
      if (!anyAlive) {
        // Entire pack dead - start respawn timer on first slot
        const respawnDelay = randomRange(spawner.respawnMs || PACK_RESPAWN_MS.min, spawner.respawnMs * 1.5 || PACK_RESPAWN_MS.max);
        spawner.slots[0].nextRespawnAt = now + respawnDelay;
      }
    } else {
      // Stray: start individual slot respawn timer
      const respawnDelay = randomRange(spawner.respawnMs || STRAY_RESPAWN_MS.min, spawner.respawnMs * 1.5 || STRAY_RESPAWN_MS.max);
      slot.nextRespawnAt = now + respawnDelay;
    }
  }
  
  // Update alive count
  spawner.aliveCount = spawner.slots.filter(s => s.aliveEnemyId !== null).length;
  
  // NOTE: We do NOT release reserved tiles - slots own them permanently
  // This prevents pack clumping over time
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function getRingForDistance(dist) {
  if (dist <= RINGS.safe.max) return 'safe';
  if (dist <= RINGS.frontier.max) return 'frontier';
  if (dist <= RINGS.wilderness.max) return 'wilderness';
  if (dist <= RINGS.danger.max) return 'danger';
  return 'deep';
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
  const count = reservedBy.size;
  const tiles = Array.from(reservedBy.entries()).map(([key, owner]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, spawnerId: owner.spawnerId, slotIndex: owner.slotIndex };
  });
  
  console.log(`[VETUU_RESERVED] ${count} tiles reserved by ${new Set(tiles.map(t => t.spawnerId)).size} spawners`);
  
  if (highlight && count > 0) {
    // Add visual markers to the map
    const actorLayer = document.getElementById('actor-layer');
    if (actorLayer) {
      // Remove existing debug markers
      actorLayer.querySelectorAll('.debug-reserved-tile').forEach(el => el.remove());
      
      // Color by spawner for visual clarity
      const spawnerColors = new Map();
      const colors = ['rgba(255,0,0,0.2)', 'rgba(0,255,0,0.2)', 'rgba(0,0,255,0.2)', 
                      'rgba(255,255,0,0.2)', 'rgba(255,0,255,0.2)', 'rgba(0,255,255,0.2)'];
      
      for (const tile of tiles) {
        if (!spawnerColors.has(tile.spawnerId)) {
          spawnerColors.set(tile.spawnerId, colors[spawnerColors.size % colors.length]);
        }
        
        const marker = document.createElement('div');
        marker.className = 'debug-reserved-tile';
        marker.style.cssText = `
          position: absolute;
          left: ${tile.x * 24}px;
          top: ${tile.y * 24}px;
          width: 24px;
          height: 24px;
          background: ${spawnerColors.get(tile.spawnerId)};
          border: 1px solid rgba(255, 255, 255, 0.5);
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

/**
 * Debug: Show player's current ring and distance from base.
 * Usage: VETUU_RING()
 */
function debugPlayerRing() {
  if (!currentState) return 'No state available';
  
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, baseCenter.x, baseCenter.y);
  const ring = getRingForDistance(dist);
  
  return {
    position: { x: player.x, y: player.y },
    distFromBase: Math.round(dist * 10) / 10,
    currentRing: ring,
    ringBounds: RINGS[ring],
    allRings: RINGS,
    baseCenter
  };
}

/**
 * Debug: Show comprehensive spawn system info.
 * Usage: VETUU_SPAWN_DEBUG()
 */
function debugSpawnSystem() {
  if (!currentState) return 'No state available';
  
  const now = nowMs();
  const player = currentState.player;
  const playerDist = distCoords(player.x, player.y, baseCenter.x, baseCenter.y);
  const bubble = getActiveBubble(player);
  const counts = countEnemiesInBubble(bubble);
  
  // Group spawners by ring
  const spawnersByRing = {
    safe: spawners.filter(s => s.ring === 'safe'),
    frontier: spawners.filter(s => s.ring === 'frontier'),
    wilderness: spawners.filter(s => s.ring === 'wilderness'),
    danger: spawners.filter(s => s.ring === 'danger'),
    deep: spawners.filter(s => s.ring === 'deep')
  };
  
  // Count eligible spawners per ring
  const eligibleByRing = {};
  for (const ring of Object.keys(spawnersByRing)) {
    eligibleByRing[ring] = spawnersByRing[ring].filter(s => isSpawnerEligible(s, now, counts)).length;
  }
  
  // Find next respawns
  const nextRespawns = spawners
    .filter(s => s.lastSpawnAt > 0)
    .map(s => ({
      id: s.id,
      ring: s.ring,
      respawnIn: Math.max(0, (s.lastSpawnAt + s.respawnMs) - now)
    }))
    .sort((a, b) => a.respawnIn - b.respawnIn)
    .slice(0, 5);
  
  return {
    playerRing: getRingForDistance(playerDist),
    playerDistFromBase: Math.round(playerDist),
    counts,
    totalSpawners: spawners.length,
    spawnersByRing: {
      safe: spawnersByRing.safe.length,
      frontier: spawnersByRing.frontier.length,
      wilderness: spawnersByRing.wilderness.length,
      danger: spawnersByRing.danger.length,
      deep: spawnersByRing.deep.length
    },
    eligibleByRing,
    nextRespawns: nextRespawns.map(r => ({
      id: r.id.slice(0, 20),
      ring: r.ring,
      respawnIn: `${Math.round(r.respawnIn / 1000)}s`
    })),
    densityCaps: {
      maxStrays: MAX_STRAYS,
      maxPacks: MAX_PACKS,
      maxTotal: MAX_TOTAL_ENEMIES
    }
  };
}

/**
 * Debug: Show spawner positions grouped by ring and level range.
 * Usage: VETUU_SPAWNER_MAP()
 */
function debugSpawnerMap() {
  if (!currentState) return 'No state available';
  
  const result = {};
  
  for (const ring of ['safe', 'frontier', 'wilderness', 'danger', 'deep']) {
    const ringSpawners = spawners.filter(s => s.ring === ring);
    result[ring] = ringSpawners.map(s => ({
      id: s.id.slice(0, 20),
      kind: s.kind,
      levelRange: s.levelRange,
      center: `(${s.center.x}, ${s.center.y})`,
      distFromBase: Math.round(distCoords(s.center.x, s.center.y, baseCenter.x, baseCenter.y)),
      enemyPool: s.enemyPool,
      packSize: s.packSize,
      aliveCount: s.aliveCount
    }));
  }
  
  return result;
}

/**
 * Debug: Show slot occupancy and respawn timers for all spawners.
 * Usage: VETUU_SPAWN_SLOTS() or VETUU_SPAWN_SLOTS('sp_nomad_inner_0')
 */
function debugSpawnSlots(spawnerId = null) {
  const now = nowMs();
  
  const targetSpawners = spawnerId 
    ? spawners.filter(s => s.id.includes(spawnerId))
    : spawners;
  
  if (targetSpawners.length === 0) {
    return `No spawners found${spawnerId ? ` matching "${spawnerId}"` : ''}`;
  }
  
  return targetSpawners.map(s => ({
    id: s.id,
    kind: s.kind,
    ring: s.ring,
    totalSlots: s.slots.length,
    validSlots: s.slots.filter(slot => slot.spawnX !== null).length,
    occupiedSlots: s.slots.filter(slot => slot.aliveEnemyId !== null).length,
    slots: s.slots.map(slot => ({
      index: slot.index,
      position: slot.spawnX ? `(${slot.spawnX}, ${slot.spawnY})` : 'NO_POSITION',
      occupied: slot.aliveEnemyId ? slot.aliveEnemyId.slice(-8) : null,
      reservedTiles: slot.reservedTiles.length,
      nextRespawnIn: slot.nextRespawnAt <= now ? 'READY' : `${Math.round((slot.nextRespawnAt - now) / 1000)}s`
    }))
  }));
}

/**
 * Debug: Show reservation ownership map.
 * Usage: VETUU_RESERVED_MAP()
 */
function debugReservedMap() {
  const result = {
    totalReserved: reservedBy.size,
    bySpawner: {}
  };
  
  for (const [key, owner] of reservedBy) {
    const spawnerId = owner.spawnerId;
    if (!result.bySpawner[spawnerId]) {
      result.bySpawner[spawnerId] = {
        slots: {},
        totalTiles: 0
      };
    }
    
    const slotKey = `slot_${owner.slotIndex}`;
    if (!result.bySpawner[spawnerId].slots[slotKey]) {
      result.bySpawner[spawnerId].slots[slotKey] = [];
    }
    
    const [x, y] = key.split(',').map(Number);
    result.bySpawner[spawnerId].slots[slotKey].push({ x, y });
    result.bySpawner[spawnerId].totalTiles++;
  }
  
  return result;
}

/**
 * Debug: Show population summary by ring.
 * Usage: VETUU_POPULATION()
 */
function debugPopulation() {
  const enemies = currentState?.runtime?.activeEnemies || [];
  const alive = enemies.filter(e => e.hp > 0);
  
  const byRing = { safe: 0, frontier: 0, wilderness: 0, danger: 0, deep: 0 };
  const packsByRing = { safe: new Set(), frontier: new Set(), wilderness: new Set(), danger: new Set(), deep: new Set() };
  
  for (const e of alive) {
    const dist = distCoords(e.spawnX || e.x, e.spawnY || e.y, baseCenter.x, baseCenter.y);
    const ring = getRingForDistance(dist);
    byRing[ring]++;
    if (e.packId) packsByRing[ring].add(e.packId);
  }
  
  // Count slot capacity
  const slotCapacity = { safe: 0, frontier: 0, wilderness: 0, danger: 0, deep: 0 };
  const occupiedSlots = { safe: 0, frontier: 0, wilderness: 0, danger: 0, deep: 0 };
  
  for (const s of spawners) {
    const ring = s.ring || 'frontier';
    const validSlots = s.slots.filter(slot => slot.spawnX !== null).length;
    const occupied = s.slots.filter(slot => slot.aliveEnemyId !== null).length;
    slotCapacity[ring] = (slotCapacity[ring] || 0) + validSlots;
    occupiedSlots[ring] = (occupiedSlots[ring] || 0) + occupied;
  }
  
  return {
    totalAlive: alive.length,
    byRing,
    packsByRing: {
      safe: packsByRing.safe.size,
      frontier: packsByRing.frontier.size,
      wilderness: packsByRing.wilderness.size,
      danger: packsByRing.danger.size,
      deep: packsByRing.deep.size
    },
    slotCapacity,
    occupiedSlots,
    fillRate: {
      safe: slotCapacity.safe > 0 ? `${Math.round(occupiedSlots.safe / slotCapacity.safe * 100)}%` : 'N/A',
      frontier: slotCapacity.frontier > 0 ? `${Math.round(occupiedSlots.frontier / slotCapacity.frontier * 100)}%` : 'N/A',
      wilderness: slotCapacity.wilderness > 0 ? `${Math.round(occupiedSlots.wilderness / slotCapacity.wilderness * 100)}%` : 'N/A',
      danger: slotCapacity.danger > 0 ? `${Math.round(occupiedSlots.danger / slotCapacity.danger * 100)}%` : 'N/A',
      deep: slotCapacity.deep > 0 ? `${Math.round(occupiedSlots.deep / slotCapacity.deep * 100)}%` : 'N/A'
    }
  };
}

// Expose debug functions to window
if (typeof window !== 'undefined') {
  window.VETUU_SPAWNS = debugListSpawns;
  window.VETUU_RESERVED = debugReservedTiles;
  window.VETUU_RESERVED_CLEAR = debugClearReservedMarkers;
  window.VETUU_RING = debugPlayerRing;
  window.VETUU_SPAWN_DEBUG = debugSpawnSystem;
  window.VETUU_SPAWNER_MAP = debugSpawnerMap;
  // New slot-based debug tools
  window.VETUU_SPAWN_SLOTS = debugSpawnSlots;
  window.VETUU_RESERVED_MAP = debugReservedMap;
  window.VETUU_POPULATION = debugPopulation;
}

export { ENEMY_TYPES, RINGS };

