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
import { initEnemyAI } from './aiUtils.js';
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
const MAX_ELITES = 1;

// NPE (New Player Experience) critter guarantees
const NPE_CRITTER_MIN = 2;
const NPE_CRITTER_MAX = 4;
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
// STATE
// ============================================
let currentState = null;
let baseCenter = { x: 236, y: 162 };  // Will be set from map offset
let baseBounds = null;
let baseBuffer = 4;
let spawners = [];
let lastSpawnTick = 0;
let lastPickedSpawnerId = null;
let spawnTickInterval = null;

// ============================================
// ENEMY TYPE DEFINITIONS
// ============================================
const ENEMY_TYPES = {
  // Critters (passive, low level)
  critter: {
    name: 'Critter',
    baseHp: 20,
    baseAtk: 3,
    baseDef: 1,
    color: '#6B5B4F',
    weapon: 'melee_bite',
    moveSpeed: 450,
    defaultAggroType: 'passive',
    defaultAggroRadius: 2,
    defaultLeashRadius: 10,
    defaultDeaggroMs: 3000
  },
  
  // Scavengers (mixed behavior)
  scav_pistol: {
    name: 'Scav Pistoleer',
    baseHp: 35,
    baseAtk: 8,
    baseDef: 3,
    color: '#8B4513',
    weapon: 'pistol',
    projectileColor: '#9B59B6',
    moveSpeed: 400,
    defaultAggroType: 'conditional',
    defaultAggroRadius: 6,
    defaultLeashRadius: 14,
    defaultDeaggroMs: 4000
  },
  scav_rifle: {
    name: 'Scav Rifleman',
    baseHp: 30,
    baseAtk: 12,
    baseDef: 2,
    color: '#A0522D',
    weapon: 'rifle',
    projectileColor: '#9B59B6',
    moveSpeed: 350,
    defaultAggroType: 'conditional',
    defaultAggroRadius: 8,
    defaultLeashRadius: 16,
    defaultDeaggroMs: 4000
  },
  scav_melee: {
    name: 'Scav Brawler',
    baseHp: 45,
    baseAtk: 10,
    baseDef: 4,
    color: '#8B5A2B',
    weapon: 'melee_club',
    moveSpeed: 380,
    defaultAggroType: 'conditional',
    defaultAggroRadius: 5,
    defaultLeashRadius: 12,
    defaultDeaggroMs: 4000
  },
  
  // Trog Warband (aggressive nomads)
  trog_warrior: {
    name: 'Trog Warrior',
    baseHp: 50,
    baseAtk: 14,
    baseDef: 5,
    color: '#556B2F',
    weapon: 'melee_spear',
    moveSpeed: 360,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 8,
    defaultLeashRadius: 18,
    defaultDeaggroMs: 5000
  },
  trog_shaman: {
    name: 'Trog Shaman',
    baseHp: 35,
    baseAtk: 18,
    baseDef: 3,
    color: '#6B8E23',
    weapon: 'ritual_bolt',
    projectileColor: '#9B59B6',
    moveSpeed: 320,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 10,
    defaultLeashRadius: 16,
    defaultDeaggroMs: 5000
  },
  
  // Karth Directorate (military, aggressive)
  karth_grunt: {
    name: 'Karth Soldier',
    baseHp: 55,
    baseAtk: 16,
    baseDef: 6,
    color: '#4A4A4A',
    weapon: 'laser_rifle',
    projectileColor: '#E74C3C',
    moveSpeed: 380,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 10,
    defaultLeashRadius: 20,
    defaultDeaggroMs: 6000
  },
  karth_officer: {
    name: 'Karth Officer',
    baseHp: 70,
    baseAtk: 20,
    baseDef: 8,
    color: '#2F2F2F',
    weapon: 'laser_pistol',
    projectileColor: '#E74C3C',
    moveSpeed: 350,
    defaultAggroType: 'aggressive',
    defaultAggroRadius: 12,
    defaultLeashRadius: 22,
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
    spawners = state.spawnerDefs.map(def => ({
      ...def,
      lastSpawnAt: 0,
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
  
  // Safe Ring: Critter strays around base perimeter
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const dist = NPE_CRITTER_ZONE_MIN + Math.random() * (NPE_CRITTER_ZONE_MAX - NPE_CRITTER_ZONE_MIN);
    result.push({
      id: `sp_stray_safe_${id++}`,
      kind: 'stray',
      ring: 'safe',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 4,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['critter'],
      levelRange: [1, 3],
      aggroType: 'passive',
      aggroRadius: 2,
      leashRadius: 10,
      deaggroTimeMs: 3000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0,
      isNpeCritter: true
    });
  }
  
  // Safe Ring: A few scav strays (conditional passive)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const dist = 14 + Math.random() * 4;
    result.push({
      id: `sp_stray_scav_safe_${id++}`,
      kind: 'stray',
      ring: 'safe',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 5,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_pistol', 'scav_melee'],
      levelRange: [3, 5],
      aggroType: 'conditional',
      aggroRadius: 4,
      leashRadius: 12,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0,
      conditions: [] // Will become aggressive in Act 3
    });
  }
  
  // Frontier Ring: Mixed strays
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dist = 22 + Math.random() * 15;
    result.push({
      id: `sp_stray_frontier_${id++}`,
      kind: 'stray',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 6,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['critter', 'scav_pistol', 'scav_melee'],
      levelRange: [4, 7],
      aggroType: 'conditional',
      aggroRadius: 5,
      leashRadius: 14,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0
    });
  }
  
  // Frontier Ring: Small packs (the "teachable" encounters)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dist = 28 + Math.random() * 10;
    result.push({
      id: `sp_pack_frontier_${id++}`,
      kind: 'pack',
      ring: 'frontier',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 7,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_pistol', 'scav_rifle', 'scav_melee'],
      levelRange: [5, 8],
      packSize: { min: 3, max: 4 },
      alpha: { chance: 0.25, max: 1 },
      aggroType: 'conditional',
      aggroRadius: 6,
      leashRadius: 14,
      deaggroTimeMs: 4000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0,
      minDistanceToOtherPacks: 12
    });
  }
  
  // Wilderness Ring: Strays (mostly aggressive)
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const dist = 45 + Math.random() * 20;
    result.push({
      id: `sp_stray_wild_${id++}`,
      kind: 'stray',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 8,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['scav_rifle', 'trog_warrior'],
      levelRange: [8, 12],
      aggroType: 'aggressive',
      aggroRadius: 7,
      leashRadius: 16,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0
    });
  }
  
  // Wilderness Ring: Packs (1-2 alphas)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const dist = 50 + Math.random() * 15;
    const isTrog = i % 2 === 0;
    result.push({
      id: `sp_pack_wild_${id++}`,
      kind: 'pack',
      ring: 'wilderness',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 8,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: isTrog ? ['trog_warrior', 'trog_shaman'] : ['scav_pistol', 'scav_rifle', 'scav_melee'],
      levelRange: [10, 14],
      packSize: { min: 4, max: 5 },
      alpha: { chance: 0.4, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 8,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0,
      minDistanceToOtherPacks: 14
    });
  }
  
  // Danger Ring: High-level strays
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const dist = 75 + Math.random() * 20;
    result.push({
      id: `sp_stray_danger_${id++}`,
      kind: 'stray',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 10,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['trog_warrior', 'karth_grunt'],
      levelRange: [14, 18],
      aggroType: 'aggressive',
      aggroRadius: 9,
      leashRadius: 18,
      deaggroTimeMs: 5000,
      respawnMs: randomRange(STRAY_RESPAWN_MS.min, STRAY_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0
    });
  }
  
  // Danger Ring: Elite packs
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dist = 80 + Math.random() * 15;
    result.push({
      id: `sp_pack_danger_${id++}`,
      kind: 'pack',
      ring: 'danger',
      center: {
        x: Math.round(baseCenter.x + Math.cos(angle) * dist),
        y: Math.round(baseCenter.y + Math.sin(angle) * dist)
      },
      spawnRadius: 10,
      noSpawnRadius: NO_SPAWN_RADIUS,
      enemyPool: ['karth_grunt', 'karth_officer'],
      levelRange: [16, 22],
      packSize: { min: 5, max: 7 },
      alpha: { chance: 0.5, max: 2 },
      aggroType: 'aggressive',
      aggroRadius: 10,
      leashRadius: 20,
      deaggroTimeMs: 6000,
      respawnMs: randomRange(PACK_RESPAWN_MS.min, PACK_RESPAWN_MS.max),
      maxAlive: 1,
      lastSpawnAt: 0,
      aliveCount: 0,
      minDistanceToOtherPacks: 16,
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
    
    for (const [packId, center] of packs) {
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
function chooseSpawner(eligible, counts) {
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
      if (pool.includes('critter') && spawner.aggroType === 'passive') {
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
  const size = spawner.kind === 'pack' 
    ? randomRange(spawner.packSize.min, spawner.packSize.max)
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

function findSpawnPositions(spawner, count) {
  const positions = [];
  const player = currentState.player;
  const maxAttempts = 50;
  
  for (let i = 0; i < count; i++) {
    let found = false;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spawner.spawnRadius;
      const x = Math.round(spawner.center.x + Math.cos(angle) * dist);
      const y = Math.round(spawner.center.y + Math.sin(angle) * dist);
      
      // Validate position
      if (!canMoveTo(currentState, x, y)) continue;
      if (isInsideBaseBounds(x, y)) continue;
      if (distCoords(x, y, player.x, player.y) < NO_SPAWN_RADIUS) continue;
      
      // Don't overlap existing enemies
      const enemies = currentState.runtime.activeEnemies || [];
      const overlap = enemies.some(e => e.hp > 0 && e.x === x && e.y === y);
      if (overlap) continue;
      
      // Don't overlap positions we already picked
      if (positions.some(p => p.x === x && p.y === y)) continue;
      
      // For packs, keep positions close together
      if (count > 1 && positions.length > 0) {
        const distToFirst = distCoords(x, y, positions[0].x, positions[0].y);
        if (distToFirst > 4) continue;
      }
      
      positions.push({ x, y });
      found = true;
      break;
    }
    
    if (!found) break;
  }
  
  return positions;
}

// ============================================
// EXECUTE SPAWN REQUESTS
// ============================================
function executeSpawnRequests(requests) {
  for (const request of requests) {
    for (let i = 0; i < request.roster.length; i++) {
      const rosterEntry = request.roster[i];
      const position = request.positions[i];
      
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
  const typeDef = ENEMY_TYPES[rosterEntry.type] || ENEMY_TYPES.critter;
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
  
  // Home/leash point
  const homeCenter = request.metadata.homeCenter || { x: position.x, y: position.y };
  
  const enemy = {
    id: `enemy_${Math.floor(t)}_${Math.random().toString(36).substr(2, 8)}`,
    spawnerId: request.spawnerId,
    packId: request.packId,
    
    // Identity
    name: typeDef.name,
    type: rosterEntry.type,
    level,
    isAlpha: rosterEntry.isAlpha,
    
    // Position
    x: position.x,
    y: position.y,
    spawnX: position.x,
    spawnY: position.y,
    
    // Home/leash point (required for AI)
    home: { x: homeCenter.x, y: homeCenter.y },
    homeCenter, // Legacy compatibility
    
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

export { ENEMY_TYPES, RINGS };

