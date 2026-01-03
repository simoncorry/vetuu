/**
 * VETUU — Combat Module
 * Tab-target MMO-style combat with smart AI, visual effects, respawning
 * 
 * AI BEHAVIOR:
 * - Critters under level 5 are passive (yellow) - attack only when provoked
 * - Melee enemies surround player and take turns attacking
 * - Ranged enemies maintain distance and use cover
 * - All enemies retreat when outclassed by nearby guards
 * 
 * ANIMATION RULE: All motion uses CSS transitions/animations for GPU acceleration.
 * JavaScript only sets final positions - CSS handles interpolation.
 * Always use translate3d() and rotate3d() for transforms.
 */

import { saveGame } from './save.js';
import { hasLineOfSight, canMoveTo, canMoveToIgnoreEnemies } from './collision.js';
import { WEAPONS, ENEMY_WEAPONS, BASIC_ATTACK_CD_MS } from './weapons.js';
import { 
  distCoords, shuffleArray, applyEffect, tickEffects,
  isSlowed, isVulnerable, isBurning, cssVar
} from './utils.js';
import { AI } from './aiConstants.js';
import { getMaxHP, getHPPercent } from './entityCompat.js';
import { nowMs, toPerfTime, isExpired } from './time.js';
import {
  isImmune, hasSpawnImmunity, isStunned, isRooted,
  isBrokenOff, isInSpawnSettle, canAggro,
  getSpawnImmunityRemaining, getSpawnSettleRemaining,
  getAggroRadius,
  startRetreat, setOnEnemyDisengageCallback,
  shouldBreakOffFromGuards, checkLeashAndDeaggro,
  ensureEffects,
  retreatPack
} from './aiUtils.js';
import { actorTransform, isActorVisible, TILE_SIZE, getViewportInfo } from './render.js';
import { SPRITES } from './sprites.js';
import { perfStart, perfEnd } from './perf.js';

// Enemy type configurations (Simplified - no weakness/resistance)
// All enemies are either melee (range 2) or ranged (range 6)
const ENEMY_CONFIGS = {
  nomad: { weapon: 'melee_club', aiType: 'melee', hp: 0.85 },
  critter: { weapon: 'melee_claws', aiType: 'melee', hp: 0.7 }, // Legacy fallback
  scav_melee: { weapon: 'melee_club', aiType: 'melee', hp: 0.9 },
  scav_ranged: { weapon: 'ranged_rifle', aiType: 'ranged', hp: 0.8 },
  trog_warrior: { weapon: 'melee_spear', aiType: 'melee', hp: 1.0 },
  trog_shaman: { weapon: 'ranged_bolt', aiType: 'ranged', hp: 0.85 },
  karth_grunt: { weapon: 'karth_laser', aiType: 'ranged', hp: 1.2 },
  karth_officer: { weapon: 'melee_club', aiType: 'melee', hp: 1.3 },
  retriever_captain: { weapon: 'boss_blade', aiType: 'aggressive', hp: 3.0 },
  ironcross_guard: { weapon: 'guard_rifle', aiType: 'guard', hp: 2.0 }
};

// Timing constants
const DEFAULT_MOVE_COOLDOWN = 400;
const GCD_MS = 1500; // Global cooldown - 1.5s lockout between abilities

// GCD state
let gcdUntil = 0; // Timestamp when GCD expires

// GCD helpers
function isGcdActive() {
  return performance.now() < gcdUntil;
}

function triggerGcd() {
  gcdUntil = performance.now() + GCD_MS;
  updateGcdUI();
}

function getGcdRemaining() {
  return Math.max(0, gcdUntil - performance.now());
}

// ============================================
// COMBAT SIMPLIFIED CONSTANTS
// ============================================
// Standardized ranges (all enemies use these)
const RANGED_RANGE = 6;

// Ranged AI distance band (maintain 3-6 tiles from player)
const RANGED_MIN_DISTANCE = 3;

// Drycross center for player respawn
let DRYCROSS_CENTER = { x: 56, y: 42 };

// Combat rules
const GUARD_LEVEL = 5; // Guard level - enemies can now fight back
const MAX_ENGAGED_ENEMIES = 2; // Only 2 enemies can actively attack at once

// Passive critter threshold (critters below this level are non-aggressive)
const PASSIVE_CRITTER_MAX_LEVEL = 5;

// ============================================
// PLAN B UNIFIED DAMAGE SYSTEM
// ============================================
// Both player and enemies use the same formula:
// (baseDamage + atk) * skillMult * levelMult * typeMult * defMult * variance
//
// To tune combat, adjust these constants in order:
// 1. DEF_K (tankiness)
// 2. LEVEL_ADV_PER, LEVEL_CAP_UP (level scaling)
// 3. Weapon baseDamage in weapons.js (pace of fights)

let COMBAT_DEBUG = false; // Toggle via VETUU_COMBAT_DEBUG_ON()

// ============================================
// RETREAT STATISTICS (for debugging)
// ============================================
const retreatStats = {
  retreatsStarted: 0,
  trueHomeSnaps: 0,       // Snap to exact spawn point
  nearFootprintSnaps: 0,  // Snap to nearby footprint tile (not exact dest)
  totalStuckDuration: 0,  // Sum of all stuck durations
  stuckCount: 0           // Number of stuck events
};

// Defense curve: damage% = DEF_K / (DEF_K + def)
// Lower DEF_K = stronger defense. At DEF_K=20: 10 DEF = 33% reduction
const DEF_K = 20;

// Level scaling (bounded, not exponential)
const LEVEL_ADV_PER = 0.07;   // +7% damage per level above target
const LEVEL_DIS_PER = 0.06;   // -6% damage per level below target
const LEVEL_CAP_UP = 1.60;    // Max +60% from level advantage
const LEVEL_CAP_DOWN = 0.55;  // Min 55% from level disadvantage

// Crit system
const CRIT_BASE = 0.05;       // 5% base crit chance
const CRIT_PER_LUCK = 0.02;   // +2% per luck point
const CRIT_MULT = 1.5;        // Crits deal 150% damage

// Damage variance
const VAR_MIN = 0.95;
const VAR_MAX = 1.05;

// ============================================
// DOM CACHE - Avoid repeated querySelector calls
// ============================================
// Map of enemyId -> DOM element (cleared on renderEnemies, updated incrementally)
const enemyEls = new Map();

/**
 * Get cached enemy element, with fallback to querySelector
 * @param {string|number} enemyId - Enemy ID
 * @returns {HTMLElement|null}
 */
function getEnemyEl(enemyId) {
  let el = enemyEls.get(enemyId);
  if (!el) {
    el = document.querySelector(`[data-enemy-id="${enemyId}"]`);
    if (el) enemyEls.set(enemyId, el);
  }
  return el;
}

// Map of npcId -> DOM element (for guards, medics, quest givers)
const npcEls = new Map();

/**
 * Get cached NPC element, with fallback to querySelector
 * @param {string|number} npcId - NPC ID
 * @returns {HTMLElement|null}
 */
function getNpcEl(npcId) {
  let el = npcEls.get(npcId);
  if (!el) {
    el = document.querySelector(`[data-npc-id="${npcId}"]`);
    if (el) npcEls.set(npcId, el);
  }
  return el;
}

// Previous visual state cache for dirty-flag optimization
// Map of enemyId -> { retreating, engaged, spawnImmune, passive }
const enemyVisualState = new Map();

// ============================================
// COLORS - Cached from CSS variables
// ============================================
// Lazily populated on first use to ensure DOM is ready
let COLORS = null;

function getColors() {
  if (!COLORS) {
    COLORS = {
      projectilePlayer: cssVar('--projectile-player'),
      projectileEnemy: cssVar('--projectile-enemy'),
      projectileSpecial: cssVar('--projectile-special'),
      projectilePsionic: cssVar('--projectile-psionic'),
      meleePlayer: cssVar('--melee-player'),
      meleeEnemy: cssVar('--melee-enemy'),
      meleeSpecial: cssVar('--melee-special'),
      abilityPush: cssVar('--ability-push'),
      abilityPull: cssVar('--ability-pull'),
      boss: cssVar('--boss')
    };
  }
  return COLORS;
}

// Debug capture for last hit
let __LAST_HIT_DEBUG = null;

// ============================================
// UNIFIED DAMAGE HELPERS
// ============================================

/**
 * Defense damage multiplier using smooth curve.
 * Returns value in (0, 1] - higher DEF = lower multiplier.
 */
function defenseMult(def) {
  if (def <= 0) return 1;
  return DEF_K / (DEF_K + def);
}

/**
 * Level difference damage multiplier (bounded, not exponential).
 * Positive delta = attacker is higher level than defender.
 */
function levelDiffMult(attackerLevel, defenderLevel) {
  const delta = attackerLevel - defenderLevel;
  if (delta > 0) {
    // Attacker advantage: +7% per level, cap at +60%
    return Math.min(LEVEL_CAP_UP, 1 + delta * LEVEL_ADV_PER);
  } else if (delta < 0) {
    // Attacker disadvantage: -6% per level, floor at 55%
    return Math.max(LEVEL_CAP_DOWN, 1 + delta * LEVEL_DIS_PER);
  }
  return 1;
}

/**
 * Type effectiveness multiplier (DISABLED - combat simplification)
 * Weakness/resistance system removed. Always returns 1.
 */
function typeMult(_damageType, _defenderConfig) {
  return 1;
}

/**
 * Roll damage variance.
 */
function rollVariance() {
  return VAR_MIN + Math.random() * (VAR_MAX - VAR_MIN);
}

/**
 * Calculate crit chance for an attacker.
 */
function critChance(attacker) {
  const luck = attacker?.luck ?? 0;
  return CRIT_BASE + luck * CRIT_PER_LUCK;
}

/**
 * UNIFIED DAMAGE CALCULATOR
 * Used by both player and enemy attacks.
 * 
 * @param {object} params
 * @param {object} params.attacker - Attacking entity (needs level, atk)
 * @param {object} params.defender - Defending entity (needs level, def)
 * @param {object} params.defenderConfig - ENEMY_CONFIGS entry (for weakness/resistance), null for player
 * @param {number} params.baseDamage - Weapon/skill base damage
 * @param {number} params.skillMult - Skill multiplier (default 1)
 * @param {string} params.damageType - Damage type for weakness calc (null = no type)
 * @param {boolean} params.forceNoCrit - If true, skip crit roll (enemies don't crit by default)
 * @param {string} params.source - "player" or "enemy" for debug
 * @param {string} params.attackId - Attack name for debug
 * @param {string} params.attackerName - Attacker name for debug
 * @returns {{damage: number, isCrit: boolean, breakdown: object}}
 */
function computeDamage({
  attacker,
  defender,
  defenderConfig = null,
  baseDamage,
  skillMult = 1,
  damageType = null,
  forceNoCrit = false,
  source = "unknown",
  attackId = null,
  attackerName = null
}) {
  // Gather stats
  const atkStat = attacker?.atk ?? 0;
  const defStat = defender?.def ?? 0;
  const atkLvl = attacker?.level ?? 1;
  const defLvl = defender?.level ?? 1;
  
  // Calculate multipliers
  const defMult = defenseMult(defStat);
  const lvlMult = levelDiffMult(atkLvl, defLvl);
  const tMult = typeMult(damageType, defenderConfig);
  const variance = rollVariance();
  
  // Crit roll
  let isCrit = false;
  let critMult = 1;
  if (!forceNoCrit) {
    const cc = critChance(attacker);
    if (Math.random() < cc) {
      isCrit = true;
      critMult = CRIT_MULT;
    }
  }
  
  // Final damage: (base + atk) * skillMult * lvlMult * tMult * defMult * variance * critMult
  const rawDamage = (baseDamage + atkStat) * skillMult * lvlMult * tMult * defMult * variance * critMult;
  const damage = Math.max(1, Math.floor(rawDamage));
  
  // Build breakdown for debugging
  const breakdown = {
    source,
    attackId,
    attackerName: attackerName || attacker?.name || "?",
    defenderName: defender?.name || "?",
    baseDamage,
    atk: atkStat,
    def: defStat,
    atkLvl,
    defLvl,
    skillMult,
    lvlMult: +lvlMult.toFixed(3),
    tMult,
    defMult: +defMult.toFixed(3),
    variance: +variance.toFixed(3),
    isCrit,
    critMult,
    rawDamage: +rawDamage.toFixed(1),
    finalDamage: damage
  };
  
  // Store for debug inspection
  __LAST_HIT_DEBUG = breakdown;
  
  if (COMBAT_DEBUG) {
    console.log(`[DAMAGE] ${breakdown.attackerName} → ${breakdown.defenderName}: ${damage}`, breakdown);
  }
  
  return { damage, isCrit, breakdown };
}

// Expose debug tools globally
if (typeof window !== 'undefined') {
  window.VETUU_LAST_HIT = () => __LAST_HIT_DEBUG;
  window.VETUU_COMBAT_DEBUG_ON = () => { COMBAT_DEBUG = true; console.log('Combat debug ON'); };
  window.VETUU_COMBAT_DEBUG_OFF = () => { COMBAT_DEBUG = false; console.log('Combat debug OFF'); };
  
  /**
   * Debug simulation harness for tuning combat balance.
   * Run from console: VETUU_DEBUG_DAMAGE()
   */
  window.VETUU_DEBUG_DAMAGE = () => {
    const SAMPLES = 50;
    
    // Simulate various matchups
    const matchups = [
      { name: "Lv1 Rex vs Lv1 Critter", atkLvl: 1, atkAtk: 5, defLvl: 1, defDef: 2, baseDmg: 10 },
      { name: "Lv1 Rex vs Lv3 Scav", atkLvl: 1, atkAtk: 5, defLvl: 3, defDef: 5, baseDmg: 10 },
      { name: "Lv1 Rex vs Lv5 Scav Alpha", atkLvl: 1, atkAtk: 5, defLvl: 5, defDef: 8, baseDmg: 10 },
      { name: "Lv5 Rex vs Lv5 Scav", atkLvl: 5, atkAtk: 9, defLvl: 5, defDef: 5, baseDmg: 12 },
      { name: "Lv5 Rex vs Lv10 Karth", atkLvl: 5, atkAtk: 9, defLvl: 10, defDef: 15, baseDmg: 12 },
      { name: "Lv1 Critter vs Lv1 Rex", atkLvl: 1, atkAtk: 3, defLvl: 1, defDef: 3, baseDmg: 8 },
      { name: "Lv5 Scav vs Lv1 Rex", atkLvl: 5, atkAtk: 8, defLvl: 1, defDef: 3, baseDmg: 10 },
      { name: "Lv10 Karth vs Lv5 Rex", atkLvl: 10, atkAtk: 15, defLvl: 5, defDef: 7, baseDmg: 14 },
    ];
    
    console.log("=== VETUU Combat Damage Simulation ===");
    console.log(`Samples per matchup: ${SAMPLES}`);
    console.log(`DEF_K=${DEF_K}, LEVEL_ADV=${LEVEL_ADV_PER}, LEVEL_DIS=${LEVEL_DIS_PER}`);
    console.log("");
    
    matchups.forEach(m => {
      const results = [];
      let crits = 0;
      
      for (let i = 0; i < SAMPLES; i++) {
        const { damage, isCrit } = computeDamage({
          attacker: { level: m.atkLvl, atk: m.atkAtk, luck: 3 },
          defender: { level: m.defLvl, def: m.defDef },
          defenderConfig: null,
          baseDamage: m.baseDmg,
          skillMult: 1,
          damageType: null,
          forceNoCrit: false,
          source: "sim",
          attackId: "test"
        });
        results.push(damage);
        if (isCrit) crits++;
      }
      
      const min = Math.min(...results);
      const max = Math.max(...results);
      const avg = (results.reduce((a, b) => a + b, 0) / SAMPLES).toFixed(1);
      const critRate = ((crits / SAMPLES) * 100).toFixed(1);
      
      console.log(`${m.name}: min=${min} max=${max} avg=${avg} crit%=${critRate}`);
    });
    
    console.log("");
    console.log("To see breakdown of any hit, call: VETUU_LAST_HIT()");
    return "Simulation complete";
  };
  
  /**
   * Debug info for a specific enemy.
   * Usage: VETUU_ENEMY_DEBUG('enemy_123...') or VETUU_ENEMY_DEBUG(0) for first enemy
   */
  window.VETUU_ENEMY_DEBUG = (idOrIndex) => {
    if (!currentState?.runtime?.activeEnemies) return 'No enemies';
    
    const t = nowMs();
    let enemy;
    
    if (typeof idOrIndex === 'number') {
      enemy = currentState.runtime.activeEnemies[idOrIndex];
    } else {
      enemy = currentState.runtime.activeEnemies.find(e => e.id === idOrIndex);
    }
    
    if (!enemy) return `Enemy not found: ${idOrIndex}`;
    
    const immuneRemaining = getSpawnImmunityRemaining(enemy, t);
    const settleRemaining = getSpawnSettleRemaining(enemy, t);
    const provokedRemaining = enemy.provokedUntil ? Math.max(0, enemy.provokedUntil - t) : 0;
    const brokenOffRemaining = enemy.brokenOffUntil ? Math.max(0, toPerfTime(enemy.brokenOffUntil) - t) : 0;
    
    return {
      id: enemy.id,
      name: enemy.name,
      type: enemy.type,
      level: enemy.level,
      hp: `${enemy.hp}/${getMaxHP(enemy)}`,
      state: enemy.state,
      isEngaged: enemy.isEngaged,
      isAware: enemy.isAware,
      isRetreating: enemy.isRetreating,
      isAlpha: enemy.isAlpha,
      position: { x: enemy.x, y: enemy.y },
      home: enemy.home,
      aggroType: enemy.aggroType,
      immuneRemainingMs: Math.round(immuneRemaining),
      settleRemainingMs: Math.round(settleRemaining),
      provokedRemainingMs: Math.round(provokedRemaining),
      brokenOffRemainingMs: Math.round(brokenOffRemaining),
      pendingAggro: !!enemy.pendingAggro,
      hasAttackerSlot: hasAttackerSlot(enemy, t),
      provokedSet: provokedEnemies.has(enemy.id)
    };
  };
  
  /**
   * Debug info for attacker slots.
   * Usage: VETUU_ATTACKERS()
   */
  window.VETUU_ATTACKERS = () => {
    return getAttackerSlotsDebug(nowMs());
  };
  
  /**
   * List all active enemies with summary info.
   * Usage: VETUU_ENEMIES()
   */
  window.VETUU_ENEMIES = () => {
    if (!currentState?.runtime?.activeEnemies) return 'No enemies';
    
    const t = nowMs();
    return currentState.runtime.activeEnemies
      .filter(e => e.hp > 0)
      .map(e => ({
        id: e.id.slice(-8),
        name: e.name,
        lv: e.level,
        state: e.state,
        hp: `${e.hp}/${getMaxHP(e)}`,
        hasSlot: hasAttackerSlot(e, t),
        immune: getSpawnImmunityRemaining(e, t) > 0,
        settle: getSpawnSettleRemaining(e, t) > 0
      }));
  };
  
  /**
   * Debug info for a specific pack.
   * Shows each member's spawn, retreat status, and footprint conflicts.
   * Usage: VETUU_PACK('pack_abc123') or VETUU_PACK() for all packs
   */
  window.VETUU_PACK = (packId) => {
    if (!currentState?.runtime?.activeEnemies) return 'No enemies';
    
    const enemies = currentState.runtime.activeEnemies.filter(e => e.hp > 0);
    
    // If no packId, show all packs
    if (!packId) {
      const packs = new Set(enemies.map(e => e.packId).filter(Boolean));
      return Array.from(packs).map(pid => window.VETUU_PACK(pid));
    }
    
    const packMembers = enemies.filter(e => e.packId === packId);
    if (packMembers.length === 0) return `No pack found: ${packId}`;
    
    // Check for footprint conflicts
    const footprintConflicts = [];
    for (const e of packMembers) {
      for (const other of packMembers) {
        if (e.id === other.id) continue;
        
        // Check if e is inside other's footprint
        const otherSpawnX = other.spawnX ?? other.x;
        const otherSpawnY = other.spawnY ?? other.y;
        const dx = Math.abs(e.x - otherSpawnX);
        const dy = Math.abs(e.y - otherSpawnY);
        
        if (dx <= 1 && dy <= 1) {
          footprintConflicts.push({
            enemy: e.id.slice(-8),
            insideFootprintOf: other.id.slice(-8),
            position: `(${e.x}, ${e.y})`,
            otherSpawn: `(${otherSpawnX}, ${otherSpawnY})`
          });
        }
      }
    }
    
    return {
      packId,
      memberCount: packMembers.length,
      members: packMembers.map(e => ({
        id: e.id.slice(-8),
        name: e.name,
        position: `(${e.x}, ${e.y})`,
        spawnPoint: `(${e.spawnX}, ${e.spawnY})`,
        retreatTo: e.retreatTo ? `(${e.retreatTo.x}, ${e.retreatTo.y})` : null,
        isRetreating: e.isRetreating,
        retreatReason: e.retreatReason,
        stuckSince: e.retreatStuckSince ? `${Date.now() - e.retreatStuckSince}ms ago` : null,
        reservedTilesCount: e.reservedTiles?.length || 0
      })),
      footprintConflicts: footprintConflicts.length > 0 ? footprintConflicts : 'None (good!)',
      healthySeparation: footprintConflicts.length === 0
    };
  };
  
  /**
   * Retreat statistics for debugging.
   * Shows snap counts, stuck durations, and other metrics.
   * Usage: VETUU_RETREAT_STATS() or VETUU_RETREAT_STATS(true) to reset
   */
  window.VETUU_RETREAT_STATS = (reset = false) => {
    if (reset) {
      retreatStats.retreatsStarted = 0;
      retreatStats.trueHomeSnaps = 0;
      retreatStats.nearFootprintSnaps = 0;
      retreatStats.totalStuckDuration = 0;
      retreatStats.stuckCount = 0;
      return 'Retreat stats reset';
    }
    
    const avgStuck = retreatStats.stuckCount > 0 
      ? Math.round(retreatStats.totalStuckDuration / retreatStats.stuckCount) 
      : 0;
    
    return {
      retreatsStarted: retreatStats.retreatsStarted,
      trueHomeSnaps: retreatStats.trueHomeSnaps,
      nearFootprintSnaps: retreatStats.nearFootprintSnaps,
      avgStuckDurationMs: avgStuck,
      stuckEvents: retreatStats.stuckCount,
      note: 'After fixes, nearFootprintSnaps should be rare'
    };
  };
}

// ============================================
// COMEBACK MECHANIC - Player Regeneration
// ============================================
// Player heals faster out of combat to encourage recovery and retry.
// In-combat regen is slower to maintain challenge.
const REGEN_OUT_OF_COMBAT_RATE = 0.25;      // 25% HP/Sense per tick (fast recovery)
const REGEN_OUT_OF_COMBAT_INTERVAL = 800;   // Every 0.8s
const REGEN_IN_COMBAT_RATE = 0.03;          // 3% HP/Sense per tick (slow trickle)
const REGEN_IN_COMBAT_INTERVAL = 5000;      // Every 5s
const COMBAT_TIMEOUT = 3000;                // 3s to be considered "out of combat"

// ============================================
// STATE
// ============================================
let currentState = null;
let currentTarget = null; // Enemy target
let currentNpcTarget = null; // Friendly NPC target (can't attack)
let currentObjectTarget = null; // Interactive object target
let currentWeapon = 'laser_rifle';
let actionCooldowns = { 1: 0, 2: 0, 3: 0 };
let actionMaxCooldowns = { 1: 1500, 2: 5000, 3: 20000 };
let combatTickInterval = null;

// Combat state tracking
let lastHitTime = 0;
let lastRegenTick = 0;

// Combat activity marker - tracks actual damage events for regen gating
// Fixes: "any engaged enemy" detection keeping player in combat forever
let lastCombatEventAt = 0;

/**
 * Mark that a combat event (damage dealt/taken) occurred.
 * Used for reliable "in combat" detection for regen gating.
 */
function markCombatEvent(t = nowMs()) {
  lastCombatEventAt = t;
}

// Melee turn tracker - which enemy attacked last, rotate through
let lastMeleeAttacker = null;

// ============================================
// ATTACKER SLOT SYSTEM (lease-based, max 2)
// ============================================
// Uses Map(id → expiresAt) instead of Set to prevent deadlocks.
// Leases expire automatically if not renewed (attack executed).
const ATTACKER_LEASE_MS = 1200; // Lease duration - must attack within this time
let attackerSlots = new Map(); // Map<enemyId, leaseExpiresAt>

/**
 * Acquire an attacker slot (lease-based).
 * Returns true if slot acquired or renewed.
 */
function acquireAttackerSlot(enemy, t = nowMs()) {
  cleanupAttackerSlots(t);
  
  // Already has slot? Renew lease
  if (attackerSlots.has(enemy.id)) {
    attackerSlots.set(enemy.id, t + ATTACKER_LEASE_MS);
    return true;
  }
  
  // Room for more attackers?
  if (attackerSlots.size < MAX_ENGAGED_ENEMIES) {
    attackerSlots.set(enemy.id, t + ATTACKER_LEASE_MS);
    return true;
  }
  
  // No slots available
  return false;
}

/**
 * Release an attacker slot (on retreat, death, broken off, failed attack).
 */
function releaseAttackerSlot(enemy) {
  attackerSlots.delete(enemy.id);
}

/**
 * Check if enemy has an active attacker slot.
 */
function hasAttackerSlot(enemy, t = nowMs()) {
  const expiresAt = attackerSlots.get(enemy.id);
  if (!expiresAt) return false;
  if (t >= expiresAt) {
    attackerSlots.delete(enemy.id);
    return false;
  }
  return true;
}

/**
 * Clean up expired/invalid attacker slots.
 */
function cleanupAttackerSlots(t = nowMs()) {
  for (const [id, expiresAt] of attackerSlots) {
    // Expired lease
    if (t >= expiresAt) {
      attackerSlots.delete(id);
      continue;
    }
    
    // Find the enemy
    const enemy = currentState?.runtime?.activeEnemies?.find(e => e.id === id);
    
    // Dead or missing
    if (!enemy || enemy.hp <= 0) {
      attackerSlots.delete(id);
      continue;
    }
    
    // Retreating or broken off
    if (enemy.isRetreating || isBrokenOff(enemy, t)) {
      attackerSlots.delete(id);
      continue;
    }
    
    // Too far from player (gave up)
    const player = currentState?.player;
    if (player) {
      const dist = distCoords(enemy.x, enemy.y, player.x, player.y);
      if (dist > 15) {
        attackerSlots.delete(id);
      }
    }
  }
}

/**
 * Get debug info about current attacker slots.
 */
function getAttackerSlotsDebug(t = nowMs()) {
  cleanupAttackerSlots(t);
  const slots = [];
  for (const [id, expiresAt] of attackerSlots) {
    const enemy = currentState?.runtime?.activeEnemies?.find(e => e.id === id);
    slots.push({
      id,
      name: enemy?.name || '?',
      remainingMs: Math.max(0, expiresAt - t)
    });
  }
  return { count: attackerSlots.size, max: MAX_ENGAGED_ENEMIES, slots };
}

// Guard state
let guards = [];

/**
 * Pending attack state - tracks "move to range then execute" flow.
 * 
 * This bridges movement with attack execution:
 * - Set by moveToAttackRange() when player needs to move to attack
 * - Checked by checkPendingAttack() every frame
 * - Cleared when: arriving in range, target invalid, or intent system takes over
 * 
 * NOTE: The intent system (combatIntent) owns "what to do" while pendingAttack
 * tracks "movement in progress for attack". When both exist, intent wins.
 * 
 * Schema: { target: Enemy, range: number, actionType: string }
 * actionType: 'basic' | 'attack' | 'weaponAbility_N' | '1'|'2'|'3' (legacy)
 */
let pendingAttack = null;

// Auto-attack state
let autoAttackEnabled = false;
let inCombat = false; // True when enemies are actively engaging the player

// Death/Ghost state
let corpseLocation = null;
let isGhostMode = false;
let playerImmunityActive = false;
let immunityTimeout = null;
const IMMUNITY_DURATION = 5000; // 5 seconds of immunity after corpse revive

// Track which enemies have been provoked (for passive critters)
let provokedEnemies = new Set();

// Burst attack timer tracking (for cancellation on target death/disengage)
let activeBurstTimers = [];

// ============================================
// ENEMY DISENGAGE HANDLER
// ============================================

/**
 * Called when an enemy disengages (starts retreat, breaks off, etc).
 * If this enemy is the player's current target or intent target,
 * immediately stop pursuit and clear combat state.
 * 
 * @param {object} enemy - The disengaging enemy
 * @param {string} reason - Why disengaging: 'leash', 'guards', 'lost', 'pack'
 * @param {number} t - Current time
 */
function onEnemyDisengage(enemy, reason, _t) {
  if (!enemy) return;
  
  // Track retreat start for debugging stats
  retreatStats.retreatsStarted++;
  
  const isCurrentTarget = currentTarget?.id === enemy.id;
  const isIntentTarget = combatIntent?.targetId === enemy.id;
  
  // Only react if this enemy is the one we're pursuing
  if (!isCurrentTarget && !isIntentTarget) return;
  
  // Release attacker slot immediately
  releaseAttackerSlot(enemy);
  
  // Clear combat intent (stops move-to-range, ability retries, etc)
  clearCombatIntent();
  
  // Stop auto-attack
  autoAttackEnabled = false;
  
  // Cancel any pending attack
  pendingAttack = null;
  
  // Cancel movement/chase via movement module
  import('./movement.js').then(({ cancelPath }) => {
    cancelPath();
  });
  
  // Clear target (optional - makes "combat ended" feel more intentional)
  if (isCurrentTarget) {
    const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
    if (el) el.classList.remove('targeted');
    currentTarget = null;
    updateTargetFrame();
    updateActionBarState();
  }
  
  // Exit combat mode
  inCombat = false;
  
  // Log to combat log so player knows what happened
  const reasonText = reason === 'guards' ? 'fled from guards' 
                   : reason === 'leash' ? 'returned home'
                   : reason === 'lost' ? 'lost interest'
                   : 'disengaged';
  logCombat(`${enemy.name} ${reasonText}.`);
}

// ============================================
// INITIALIZATION
// ============================================
export function initCombat(state) {
  currentState = state;
  
  // Register disengage callback with aiUtils
  setOnEnemyDisengageCallback(onEnemyDisengage);

  if (!state.runtime.activeEnemies) {
    state.runtime.activeEnemies = [];
  }

  // Update Drycross center based on expanded map (for player respawn)
  if (state.map.meta?.originalOffset) {
    const ox = state.map.meta.originalOffset.x;
    const oy = state.map.meta.originalOffset.y;
    
    DRYCROSS_CENTER = {
      x: 56 + ox,
      y: 42 + oy
    };
  }

  initGuardsFromNPCs();
  startCombatTick();
  updateActionBar();
}

// ============================================
// GUARDS FROM NPCs
// ============================================
function initGuardsFromNPCs() {
  guards = currentState.entities.npcs
    .filter(npc => npc.isGuard)
    .map(npc => ({
      id: npc.id,
      name: npc.name,
      x: npc.x,
      y: npc.y,
      level: GUARD_LEVEL,
      hp: 100 + GUARD_LEVEL * 10, // Guards have HP now
      maxHP: 100 + GUARD_LEVEL * 10,
      cooldownUntil: 0,
      color: npc.color
    }));
}

// ============================================
// DRYCROSS GUARDS
// ============================================
function checkGuardIntercept() {
  if (!currentState?.runtime?.activeEnemies || guards.length === 0) return;

  const guardWeapon = ENEMY_WEAPONS.guard_rifle;
  const guardRange = guardWeapon?.range || 4;

  for (const enemy of currentState.runtime.activeEnemies) {
    if (enemy.hp <= 0 || enemy.isGuard) continue;

    // Guards engage any enemy that is aggroed (aware/engaged with player)
    // This protects the player when they bring enemies back toward base
    const isAggroed = enemy.isEngaged || enemy.isAware || provokedEnemies.has(enemy.id);
    if (!isAggroed) continue;
    
    // Find nearest alive guard within range
      let nearestGuard = null;
      let nearestDist = Infinity;

      for (const guard of guards) {
      if (!guard.hp || guard.hp <= 0) continue; // Skip dead guards
        const dist = distCoords(guard.x, guard.y, enemy.x, enemy.y);
      if (dist <= guardRange && dist < nearestDist) {
          nearestDist = dist;
          nearestGuard = guard;
        }
      }

      if (nearestGuard) {
        // Guard attacks enemy
        guardAttack(nearestGuard, enemy);
      
      // Enemy fights back if still alive and in range
      if (enemy.hp > 0) {
        enemyAttackGuard(enemy, nearestGuard);
      }
    }
  }
}

// Enemy attacks a guard (uses unified damage)
function enemyAttackGuard(enemy, guard) {
  const now = nowMs();
  if (!isExpired(enemy.cooldownUntil, now)) return;
  if (!guard.hp || guard.hp <= 0) return;
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.nomad;
  const weapon = ENEMY_WEAPONS[config.weapon];
  const d = distCoords(enemy.x, enemy.y, guard.x, guard.y);
  
  if (d <= weapon.range && hasLineOfSight(currentState, enemy.x, enemy.y, guard.x, guard.y)) {
    // Use unified damage calculation (alpha bonus is already in enemy.atk)
    const { damage } = computeDamage({
      attacker: enemy,
      defender: guard,
      defenderConfig: null,
      baseDamage: weapon.baseDamage || 10,
      skillMult: weapon.multiplier || 1,
      damageType: weapon.damageType || null,
      forceNoCrit: true,
      source: "enemy",
      attackId: "guard_attack",
      attackerName: enemy.name || enemy.type
    });
    
    guard.hp -= damage;
    
    if (weapon.type === 'ranged') {
      showProjectile(enemy.x, enemy.y, guard.x, guard.y, weapon.projectileColor || getColors().projectileEnemy);
    } else {
      showMeleeSwipe(enemy.x, enemy.y, guard.x, guard.y, weapon.projectileColor || getColors().projectileEnemy);
    }
    
    showDamageNumber(guard.x, guard.y, damage, false);
    logCombat(`${enemy.name} attacks Ironcross Guard for ${damage}!`);
    
    enemy.cooldownUntil = now + weapon.cooldown;
    
    // Check if guard died
    if (guard.hp <= 0) {
      handleGuardDeath(guard);
    }
  }
}

// Handle guard death
function handleGuardDeath(guard) {
  guard.hp = 0;
  logCombat(`Ironcross Guard has fallen!`);
  
  // Visual feedback - mark guard as downed
  const guardEl = getNpcEl(guard.id);
  if (guardEl) {
    guardEl.classList.add('dying');
    guardEl.addEventListener('animationend', function handler() {
      guardEl.classList.remove('dying');
      guardEl.classList.add('downed');
      guardEl.removeEventListener('animationend', handler);
    });
  }
  
  // Respawn guard after 30 seconds
  setTimeout(() => {
    guard.hp = getMaxHP(guard);
    if (guardEl) {
      guardEl.classList.remove('downed');
    }
    logCombat('Ironcross Guard has recovered!');
  }, 30000);
}

function guardAttack(guard, enemy) {
  const t = nowMs();
  if (!isExpired(guard.cooldownUntil, t)) return;

  const weapon = ENEMY_WEAPONS.guard_rifle;
  const dist = distCoords(guard.x, guard.y, enemy.x, enemy.y);

  if (dist <= weapon.range && hasLineOfSight(currentState, guard.x, guard.y, enemy.x, enemy.y)) {
    const damage = weapon.baseDamage;
    enemy.hp -= damage;
    
    showProjectile(guard.x, guard.y, enemy.x, enemy.y, weapon.projectileColor);
    showDamageNumber(enemy.x, enemy.y, damage, true);
    logCombat(`Ironcross Guard blasts ${enemy.name} for ${damage}!`);

    guard.cooldownUntil = t + weapon.cooldown;

    updateEnemyHealthBar(enemy);
    if (enemy.hp <= 0) {
      handleEnemyDeath(enemy);
    }
  }
}

// ============================================
// COMBAT TICK (100ms intervals)
// ============================================
let lastUIUpdateTick = 0; // Throttle UI updates to every 2nd tick

function startCombatTick() {
  if (combatTickInterval) return;

  combatTickInterval = setInterval(() => {
    if (!currentState) return;
    
    perfStart('combat:tick');

    // Use performance.now() for all simulation timing
    const now = nowMs();
    lastUIUpdateTick++;

    // Update player cooldowns (weapon abilities)
    for (const key of Object.keys(actionCooldowns)) {
      if (actionCooldowns[key] > 0) actionCooldowns[key] -= 100;
    }
    
    // Throttle UI updates to every 200ms (every 2nd tick)
    if (lastUIUpdateTick >= 2) {
      updateCooldownUI();
      updateGcdUI();
      lastUIUpdateTick = 0;
    }
    
    // Update utility cooldowns (sprint, heal)
    tickUtilityCooldowns(100);
    
    // Update sense cooldowns (push, pull)
    tickSenseCooldowns(100);
    
    // Drop focus on targets that are too far away (outside viewport + 10% buffer)
    checkTargetDistance();

    // Try to execute combat intent (handles immunity expiry, movement completion)
    tryExecuteCombatIntent();

    // Process auto-attack
    processAutoAttack();

    // Process regeneration
    processRegeneration(now);

    // Process each active enemy (only if there are enemies to process)
    const enemies = currentState.runtime.activeEnemies;
    if (enemies.length > 0) {
      perfStart('combat:enemyAI');
      for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        if (enemy.hp > 0) {
          processEnemyAI(enemy, now);
        }
      }
      perfEnd('combat:enemyAI');

      // Check guard intercepts (only relevant when enemies exist)
      checkGuardIntercept();

      // Tick status effects and update visuals
      tickAllEnemyEffects();
    }

    // Respawning is handled by spawnDirector.js
    
    perfEnd('combat:tick');

  }, 100);
}

// ============================================
// AUTO-ATTACK SYSTEM
// ============================================
// NOTE: Attack execution is now handled by the Combat Intent System (executeBasicIntent).
// This function only manages combat state and target acquisition.
function processAutoAttack() {
  // Check if we should stay in combat:
  // 1. We have a valid living target
  // 2. OR there are engaged enemies
  // 3. OR there are provoked enemies
  const hasValidTarget = currentTarget && currentTarget.hp > 0;
  const engagedEnemies = getEngagedEnemies();
  const hasProvokedEnemies = provokedEnemies.size > 0;
  
  // Stay in combat if any of these conditions are true
  const shouldStayInCombat = hasValidTarget || engagedEnemies.length > 0 || hasProvokedEnemies;
  
  if (!shouldStayInCombat) {
    // No reason to stay in combat - end it
    if (inCombat) {
      endCombat();
    }
    return;
  }
  
  // We're in combat
  if (!inCombat) {
    inCombat = true;
  }
  
  // Auto-attack only runs if enabled
  if (!autoAttackEnabled) return;
  
  // If no target or target is dead, find next target
  if (!currentTarget || currentTarget.hp <= 0) {
    // First try engaged enemies
    const nextEnemy = findNextCombatTarget();
    if (nextEnemy) {
      selectTarget(nextEnemy);
    } else {
      // Try finding any nearby enemy
      const nearestEnemy = findNearestEnemy();
      if (nearestEnemy) {
        selectTarget(nearestEnemy);
      } else {
        // No valid targets - but don't end combat yet, stay in combat mode
        return;
      }
    }
  }
  
  // Ensure target is still valid after selection
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  // Ensure we have a combat intent if auto-attack is enabled
  // Only create basic intent if NO intent exists - don't overwrite weaponAbility intents!
  if (!combatIntent) {
    setAutoAttackIntent(currentTarget);
  }
  
  // Attack execution is handled by tryExecuteCombatIntent() called elsewhere in the tick
}

// Get all enemies that are actively engaged with the player
function getEngagedEnemies() {
  if (!currentState?.runtime?.activeEnemies) return [];
  return currentState.runtime.activeEnemies.filter(e => 
    e.hp > 0 && (e.isEngaged || e.state === 'ENGAGED')
  );
}

// Get all enemies that are engaged OR provoked (attacked by player abilities)
function getAggressiveEnemies() {
  if (!currentState?.runtime?.activeEnemies) return [];
  const t = nowMs();
  return currentState.runtime.activeEnemies.filter(e => {
    if (e.hp <= 0) return false;
    // Engaged enemies
    if (e.isEngaged || e.state === 'ENGAGED') return true;
    // Provoked enemies (e.g., hit by Push/Pull)
    if (provokedEnemies.has(e.id) && !isExpired(e.provokedUntil, t)) return true;
    return false;
  });
}

// Find the next enemy to target - prioritize enemies attacking the player or provoked
function findNextCombatTarget() {
  const player = currentState.player;
  const aggressive = getAggressiveEnemies();
  
  if (aggressive.length === 0) return null;
  
  // Sort by distance - closest aggressive enemy first
  aggressive.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  return aggressive[0];
}

// End combat state
function endCombat() {
  inCombat = false;
  autoAttackEnabled = false;
  provokedEnemies.clear(); // Clear provoked enemies when combat ends
  pendingAttack = null;
  clearBurstTimers(); // Cancel any in-flight burst attacks
  
  // Clear combat intent - prevents auto-reengaging when walking back
  clearCombatIntent();
  
  // Clear target selection - player must explicitly re-target to fight again
  // This is important for passive enemies that retreated
  if (currentTarget) {
    const el = document.querySelector(`[data-enemy-id="${currentTarget.id}"]`);
    if (el) el.classList.remove('targeted');
    currentTarget = null;
    updateTargetFrame();
    updateActionBarState();
  }
  
  logCombat('Combat ended.');
}

// Find the nearest enemy (any distance) - used when no target and pressing action keys
// Only returns enemies that are valid combat targets (engaged, provoked, or hostile)
function findNearestEnemy() {
  const player = currentState.player;
  
  // Prioritize engaged enemies first
  const engaged = getEngagedEnemies();
  if (engaged.length > 0) {
    engaged.sort((a, b) => {
      const distA = distCoords(a.x, a.y, player.x, player.y);
      const distB = distCoords(b.x, b.y, player.x, player.y);
      return distA - distB;
    });
    return engaged[0];
  }
  
  // Fall back to provoked enemies (player attacked them recently)
  const provoked = currentState.runtime.activeEnemies.filter(e => 
    e.hp > 0 && provokedEnemies.has(e.id)
  );
  if (provoked.length > 0) {
    provoked.sort((a, b) => {
      const distA = distCoords(a.x, a.y, player.x, player.y);
      const distB = distCoords(b.x, b.y, player.x, player.y);
      return distA - distB;
    });
    return provoked[0];
  }
  
  // Fall back to hostile enemies only (not passive, not retreating)
  // Passive enemies (critters under level 5) should not be auto-targeted
  const hostile = currentState.runtime.activeEnemies.filter(e => 
    e.hp > 0 && 
    !e.isRetreating && 
    !isEnemyPassive(e) &&
    e.state !== 'UNAWARE'
  );
  
  if (hostile.length === 0) return null;
  
  hostile.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  return hostile[0];
}

/**
 * Find the closest valid enemy within a specific range.
 * Used by weapon abilities to auto-acquire targets within ability range.
 * 
 * @param {object} options
 * @param {number} options.maxRange - Maximum distance to consider
 * @param {boolean} options.requireLOS - Whether line of sight is required
 * @returns {object|null} - The closest valid enemy or null
 */
function acquireClosestEnemyInRange({ maxRange, requireLOS = false }) {
  const player = currentState.player;
  const enemies = currentState.runtime.activeEnemies || [];
  
  // Filter to valid candidates using centralized validity check
  const candidates = enemies.filter(e => {
    // Use centralized validity check (dead, retreating, broken_off)
    if (isInvalidCombatTarget(e).invalid) return false;
    
    // Check distance
    const dist = distCoords(player.x, player.y, e.x, e.y);
    if (dist > maxRange) return false;
    
    // Check LOS if required
    if (requireLOS && !hasLineOfSight(currentState, player.x, player.y, e.x, e.y)) {
      return false;
    }
    
    return true;
  });
  
  if (candidates.length === 0) return null;
  
  // Sort by distance and return closest
  candidates.sort((a, b) => {
    const distA = distCoords(player.x, player.y, a.x, a.y);
    const distB = distCoords(player.x, player.y, b.x, b.y);
    return distA - distB;
  });
  
  return candidates[0];
}

// ============================================
// REGENERATION SYSTEM
// ============================================
function processRegeneration(now) {
  const player = currentState.player;
  const timeSinceHit = now - lastHitTime;
  
  // Use lastCombatEventAt for reliable combat detection
  // This fixes: "any engaged enemy" keeping player in combat forever (stuck sense)
  const isInCombat = (now - lastCombatEventAt) <= COMBAT_TIMEOUT;

  if (!isInCombat || timeSinceHit > COMBAT_TIMEOUT) {
    if (now - lastRegenTick >= REGEN_OUT_OF_COMBAT_INTERVAL) {
      lastRegenTick = now;
      
      const playerMax = getMaxHP(player);
      const hpRegen = Math.ceil(playerMax * REGEN_OUT_OF_COMBAT_RATE);
      const senseRegen = Math.ceil(player.maxSense * REGEN_OUT_OF_COMBAT_RATE);
      
      if (player.hp < playerMax) {
        player.hp = Math.min(playerMax, player.hp + hpRegen);
      }
      if (player.sense < player.maxSense) {
        player.sense = Math.min(player.maxSense, player.sense + senseRegen);
      }

      updatePlayerHealthBar();
      updatePlayerSenseBar();
    }
  } else if (timeSinceHit >= REGEN_IN_COMBAT_INTERVAL) {
    if (now - lastRegenTick >= REGEN_IN_COMBAT_INTERVAL) {
      lastRegenTick = now;
      
      const playerMaxCombat = getMaxHP(player);
      const hpRegen = Math.ceil(playerMaxCombat * REGEN_IN_COMBAT_RATE);
      const senseRegen = Math.ceil(player.maxSense * REGEN_IN_COMBAT_RATE);
      
      if (player.hp < playerMaxCombat) {
        player.hp = Math.min(playerMaxCombat, player.hp + hpRegen);
      }
      if (player.sense < player.maxSense) {
        player.sense = Math.min(player.maxSense, player.sense + senseRegen);
      }

      updatePlayerHealthBar();
      updatePlayerSenseBar();
    }
  }
}

// ============================================
// ENEMY AI - STATE MACHINE WITH PROPER LEASHING
// ============================================
// States: UNAWARE -> ALERT -> ENGAGED -> RETREATING -> UNAWARE
// 
// PRIORITY ORDER (explicit, no early returns that block aggro):
// 1. Dead check
// 2. Player ghost/immunity: disengage + return home
// 3. Stunned: no actions
// 4. Retreating handler
// 5. pendingAggro resolution (provoked while broken off)
// 6. brokenOff handler
// 7. Guard retreat checks
// 8. Passive/conditional gating (unless provoked)
// 9. Engaged handler: leash/deaggro + combat AI
// 10. Detection: UNAWARE -> ALERT -> ENGAGED
//
// CRITICAL: Spawn immunity blocks DAMAGE only, not detection/aggro.
// CRITICAL: Spawn settle blocks ATTACKS only, not detection/aggro.

function processEnemyAI(enemy, t) {
  // ============================================
  // 1. DEAD CHECK
  // ============================================
  if (enemy.hp <= 0) return;
  
  // Initialize AI fields if needed
  if (!enemy.state) {
    initEnemyAIFields(enemy);
  }
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.nomad;
  const weapon = ENEMY_WEAPONS[config.weapon];
  const player = currentState.player;
  const dPlayer = distCoords(enemy.x, enemy.y, player.x, player.y);
  const hasLOS = hasLineOfSight(currentState, enemy.x, enemy.y, player.x, player.y);
  
  // ============================================
  // 2. PLAYER GHOST/IMMUNITY - Disengage
  // ============================================
  if (isGhostMode || playerImmunityActive) {
    enemy.isEngaged = false;
    enemy.isAware = false;
    enemy.state = AI.STATES.UNAWARE;
    releaseAttackerSlot(enemy);
    
    // Return home if outside footprint (Chebyshev > 1)
    const homeX = enemy.spawnX ?? enemy.home?.x ?? enemy.x;
    const homeY = enemy.spawnY ?? enemy.home?.y ?? enemy.y;
    const dHomeCheb = Math.max(Math.abs(enemy.x - homeX), Math.abs(enemy.y - homeY));
    if (dHomeCheb > 1) {
      moveEnemyTowardHome(enemy, homeX, homeY);
    }
    return;
  }
  
  // ============================================
  // 3. STUNNED - No actions
  // ============================================
  if (isStunned(enemy, t)) {
    return;
  }
  
  // ============================================
  // 4. RETREATING HANDLER
  // ============================================
  if (enemy.isRetreating) {
    releaseAttackerSlot(enemy);
    handleRetreatState(enemy, t);
    return;
  }
  
  // ============================================
  // 5. PENDING AGGRO RESOLUTION
  // ============================================
  // If enemy was provoked while broken off/retreating, and can now aggro
  if (enemy.pendingAggro && canAggro(enemy, t)) {
    enemy.isAware = true;
    enemy.awareTime = t - AI.ALERT_DURATION_MS;
    enemy.lastSeenPlayer = t;
    enemy.isEngaged = true;
    enemy.state = AI.STATES.ENGAGED;
    enemy.targetId = 'player';
    enemy.pendingAggro = false;
    // Fall through to engaged handler
}

// ============================================
  // 6. BROKEN OFF HANDLER
// ============================================
  if (isBrokenOff(enemy, t)) {
    enemy.targetId = null;
    enemy.isEngaged = false;
    enemy.isAware = false;
    releaseAttackerSlot(enemy);
    
    // Move toward home or idle - use Chebyshev distance for footprint
    const homeX = enemy.spawnX ?? enemy.home?.x ?? enemy.x;
    const homeY = enemy.spawnY ?? enemy.home?.y ?? enemy.y;
    const dHomeCheb = Math.max(Math.abs(enemy.x - homeX), Math.abs(enemy.y - homeY));
    if (dHomeCheb > 1) {
      moveEnemyTowardHome(enemy, homeX, homeY);
    } else if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.02) {
      aiIdle(enemy, t, weapon);
    }
    return;
  }
  
  // ============================================
  // 7. GUARD RETREAT CHECKS
  // ============================================
  if (shouldBreakOffFromGuards(enemy, guards, t)) {
    startRetreat(enemy, t, 'guards');
    releaseAttackerSlot(enemy);
    
    if (enemy.packId) {
      retreatPack(enemy.packId, currentState.runtime.activeEnemies, t, 'guards');
    }
    
    updateEnemyVisuals();
    return;
  }
  
  // ============================================
  // 8. PASSIVE/CONDITIONAL GATING
  // ============================================
  const aggroType = enemy.aggroType || (isEnemyPassive(enemy) ? 'passive' : 'aggressive');
  const isProvoked = provokedEnemies.has(enemy.id) && !isExpired(enemy.provokedUntil, t);
  
  // Passive: only engage if provoked
  if (aggroType === 'passive' && !isProvoked) {
    handleUnawareState(enemy, t, weapon);
    return;
  }

  // Conditional: check flags
  if (aggroType === 'conditional') {
    const isAct3 = currentState.flags?.act3;
    if (!isAct3 && !isProvoked) {
      handleUnawareState(enemy, t, weapon);
      return;
    }
  }
  
  // ============================================
  // 9. ENGAGED HANDLER - Leash/Deaggro + Combat
  // ============================================
  if (enemy.isEngaged || enemy.state === AI.STATES.ENGAGED) {
    const retreatReason = checkLeashAndDeaggro(enemy, player, t);
    
    if (retreatReason) {
      startRetreat(enemy, t, retreatReason);
      releaseAttackerSlot(enemy);
      
      if (retreatReason === 'leash' && enemy.packId) {
        retreatPack(enemy.packId, currentState.runtime.activeEnemies, t, 'leash');
      }
      
      updateEnemyVisuals();
      return;
    }
    
    // Execute combat AI (handles spawn settle internally)
    executeCombatAI(enemy, weapon, dPlayer, hasLOS, t, config);
    return;
  }
  
  // ============================================
  // 10. DETECTION: UNAWARE -> ALERT -> ENGAGED
  // ============================================
  // NOTE: Spawn immunity/settle do NOT block detection/aggro
  const aggroRadius = getAggroRadius(enemy);
  
  // Check if player is in detection range with LOS
  if (hasLOS && dPlayer <= aggroRadius) {
    if (!enemy.isAware) {
      // Enter ALERT state
      enemy.isAware = true;
      enemy.awareTime = t;
      enemy.state = AI.STATES.ALERT;
      enemy.lastSeenPlayer = t;
    } else {
      enemy.lastSeenPlayer = t;
    }
  }
  
  // Handle ALERT -> ENGAGED transition
  if (enemy.state === AI.STATES.ALERT) {
    const alertTime = toPerfTime(enemy.awareTime);
    if (t - alertTime >= AI.ALERT_DURATION_MS) {
      enemy.state = AI.STATES.ENGAGED;
  enemy.isEngaged = true;
      enemy.targetId = 'player';
      executeCombatAI(enemy, weapon, dPlayer, hasLOS, t, config);
    }
    return;
  }
  
  // Not aware - handle unaware state
  handleUnawareState(enemy, t, weapon);
}

/**
 * Initialize AI fields on enemy
 */
function initEnemyAIFields(enemy) {
  enemy.state = AI.STATES.UNAWARE;
  enemy.isRetreating = false;
  enemy.isEngaged = false;
  enemy.isAware = false;
  enemy.moveCooldown = enemy.moveCooldown ?? 0;
  enemy.lastSeenPlayer = 0;
  enemy.outOfRangeSince = null;
  
  // Set home if not set
  // CRITICAL: Use spawnX/spawnY (per-enemy unique) NOT homeCenter (shared pack center)
  if (!enemy.home) {
    enemy.home = {
      x: enemy.spawnX ?? enemy.homeCenter?.x ?? enemy.x,
      y: enemy.spawnY ?? enemy.homeCenter?.y ?? enemy.y
    };
  }
  
  // Default ranges (alphas get +4 leash, +2 aggro)
  enemy.leashRadius = enemy.leashRadius ?? (enemy.isAlpha ? AI.DEFAULT_LEASH_RADIUS + 4 : AI.DEFAULT_LEASH_RADIUS);
  enemy.aggroRadius = enemy.aggroRadius ?? (enemy.isAlpha ? AI.DEFAULT_AGGRO_RADIUS + 2 : AI.DEFAULT_AGGRO_RADIUS);
  
  ensureEffects(enemy);
}

/**
 * Handle unaware state - idle or return home
 * Uses Chebyshev distance to stay within 3×3 footprint (distance <= 1 from spawn)
 */
function handleUnawareState(enemy, t, weapon) {
  enemy.isEngaged = false;
  enemy.state = AI.STATES.UNAWARE;
  
  if (!enemy.home) return;
  
  // Use Chebyshev distance (max of dx, dy) to respect 3×3 footprint
  // Footprint is 1 tile from center, so we're "at home" if Chebyshev <= 1
  const homeX = enemy.spawnX ?? enemy.home.x;
  const homeY = enemy.spawnY ?? enemy.home.y;
  const dHomeCheb = Math.max(Math.abs(enemy.x - homeX), Math.abs(enemy.y - homeY));
  
  if (dHomeCheb > 1) {
    // Outside footprint - return home
    moveEnemyTowardHome(enemy, homeX, homeY);
    regenAtHome(enemy, t);
  } else {
    // Inside footprint - regenerate and maybe idle
    regenAtHome(enemy, t);
    
    if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.02) {
      aiIdle(enemy, t, weapon);
    }
  }
}

/**
 * Regenerate HP when at or near home
 */
function regenAtHome(enemy, t) {
  const enemyMax = getMaxHP(enemy);
  if (!enemyMax || enemy.hp >= enemyMax) return;
  
  const regenInterval = 500;
  if (!enemy.lastRegenTick || t - enemy.lastRegenTick >= regenInterval) {
    const regenRate = 0.05; // 5% per tick
    const regenAmount = Math.ceil(enemyMax * regenRate);
    enemy.hp = Math.min(enemyMax, enemy.hp + regenAmount);
    updateEnemyHealthBar(enemy);
    enemy.lastRegenTick = t;
    
    // Clear provoked when mostly healed
    if (enemy.hp >= enemyMax * 0.9) {
      provokedEnemies.delete(enemy.id);
    }
  }
}

/**
 * Handle enemy retreat state - move toward retreat destination, heal, and finish when arrived.
 * 
 * STABILITY RULES:
 * 1. Retreat destination is ALWAYS enemy.spawnX/spawnY (never recomputed dynamically)
 * 2. Arrival is EXACT grid match (enemy.x === retreatTo.x && enemy.y === retreatTo.y)
 * 3. Movement is CLAMPED to 1 tile per move step (no multi-tile jumps)
 * 4. Timeout snap is LAST RESORT only - requires being stuck AND far from destination
 * 5. When close to destination, be patient - don't snap for temporary blockages
 */
function handleRetreatState(enemy, t) {
  // CRITICAL: Retreat destination is per-enemy spawn point (never shared, never recomputed)
  // This is set ONCE when retreat starts and should not change
  if (!enemy.retreatTo) {
    // Use authoritative spawn position (unique per enemy from spawn footprint)
    enemy.retreatTo = {
      x: enemy.spawnX ?? enemy.home?.x ?? enemy.x,
      y: enemy.spawnY ?? enemy.home?.y ?? enemy.y
    };
  }
  
  const destX = enemy.retreatTo.x;
  const destY = enemy.retreatTo.y;
  const distToDest = distCoords(enemy.x, enemy.y, destX, destY);
  
  // Heal while retreating (15% per second = 1.5% per 100ms tick)
  const retreatMax = getMaxHP(enemy);
  if (retreatMax && enemy.hp < retreatMax) {
    const regenRate = AI.RETREAT_REGEN_RATE;
    const regenAmount = retreatMax * regenRate * 0.1; // ~100ms tick
    enemy.hp = Math.min(retreatMax, enemy.hp + regenAmount);
    updateEnemyHealthBar(enemy);
  }
  
  // CRITICAL: Arrival is EXACT grid match (prevents "close enough" snapping)
  if (enemy.x === destX && enemy.y === destY) {
    finishRetreat(enemy, t);
    return;
  }
  
  // Move toward retreat destination (faster movement during retreat)
  const moveCD = 320; // Faster than normal
  if (!isExpired(enemy.moveCooldown, t)) return;
  
  // Store previous distance to track if we're making progress
  enemy._retreatPrevDist = distToDest;
  
  // CRITICAL: Movement is EXACTLY 1 tile per step (dx and dy are -1, 0, or 1)
  const dx = Math.sign(destX - enemy.x);
  const dy = Math.sign(destY - enemy.y);
  
  let moved = false;
  
  // Try cardinal directions first (more predictable pathing)
  // Priority: direct line to goal, then fallback
  if (dx !== 0 && dy === 0) {
    // Pure horizontal movement needed
    if (canEnemyMoveToRetreat(enemy.x + dx, enemy.y, enemy.id)) {
      updateEnemyPosition(enemy, enemy.x + dx, enemy.y);
      moved = true;
    }
  } else if (dx === 0 && dy !== 0) {
    // Pure vertical movement needed
    if (canEnemyMoveToRetreat(enemy.x, enemy.y + dy, enemy.id)) {
      updateEnemyPosition(enemy, enemy.x, enemy.y + dy);
      moved = true;
    }
  } else if (dx !== 0 && dy !== 0) {
    // Diagonal movement needed - try horizontal first, then vertical, then diagonal
    if (canEnemyMoveToRetreat(enemy.x + dx, enemy.y, enemy.id)) {
      updateEnemyPosition(enemy, enemy.x + dx, enemy.y);
      moved = true;
    } else if (canEnemyMoveToRetreat(enemy.x, enemy.y + dy, enemy.id)) {
      updateEnemyPosition(enemy, enemy.x, enemy.y + dy);
      moved = true;
    } else if (canEnemyMoveToRetreat(enemy.x + dx, enemy.y + dy, enemy.id)) {
      updateEnemyPosition(enemy, enemy.x + dx, enemy.y + dy);
      moved = true;
    }
  }
  
  // If can't move toward goal, try any adjacent tile closer to destination
  if (!moved) {
    const adjacentMoves = [
      { x: enemy.x + 1, y: enemy.y },
      { x: enemy.x - 1, y: enemy.y },
      { x: enemy.x, y: enemy.y + 1 },
      { x: enemy.x, y: enemy.y - 1 },
    ];
    
    // Sort by distance to retreat destination
    adjacentMoves.sort((a, b) => {
      const distA = distCoords(a.x, a.y, destX, destY);
      const distB = distCoords(b.x, b.y, destX, destY);
      return distA - distB;
    });
    
    for (const pos of adjacentMoves) {
      // Only move if it gets us closer
      const currentDist = distCoords(enemy.x, enemy.y, destX, destY);
      const newDist = distCoords(pos.x, pos.y, destX, destY);
      if (newDist < currentDist && canEnemyMoveToRetreat(pos.x, pos.y, enemy.id)) {
        updateEnemyPosition(enemy, pos.x, pos.y);
        moved = true;
        break;
      }
    }
  }
  
  // Track if stuck and determine if we should snap
  // STABILITY: Only snap if truly stuck AND not making progress AND far enough to warrant it
  if (!moved) {
    enemy.retreatStuckSince = enemy.retreatStuckSince ?? t;
    const stuckDuration = t - enemy.retreatStuckSince;
    const retreatDur = t - (enemy.retreatStartedAt ?? t);
    
    // Track stuck events for debugging
    if (stuckDuration > 0) {
      retreatStats.totalStuckDuration += stuckDuration;
      retreatStats.stuckCount++;
    }
    
    // Check if destination is blocked by another enemy
    const destBlocked = !canEnemyMoveToRetreat(destX, destY, enemy.id);
    
    // PHASE 4: Very conservative snap thresholds near home
    // When close (distToDest <= 2), we're patient and NEVER use retreatDur timeout
    // The enemy will wait for the destination to become free
    const isNearHome = distToDest <= 2;
    
    let shouldSnap = false;
    
    if (isNearHome) {
      // Near home: only snap if stuck for a VERY long time (8-10s)
      // Never snap based on total retreat duration when close
      const nearHomeStuckThreshold = destBlocked ? 10000 : 8000;
      shouldSnap = stuckDuration > nearHomeStuckThreshold;
    } else {
      // Far from home: more aggressive snap behavior
      const farStuckThreshold = destBlocked ? 6000 : 2000;
      shouldSnap = stuckDuration > farStuckThreshold || retreatDur > AI.RETREAT_TIMEOUT_MS * 1.5;
    }
    
    if (shouldSnap) {
      // LAST RESORT: Snap to destination
      // But first, check if destination is actually reachable (not occupied)
      if (!destBlocked) {
        snapEnemyToHome(enemy, t);
      } else {
        // Destination is blocked - find nearest free tile in footprint
        // NOTE: snapNearHomeWithinFootprint does NOT finish retreat
        snapNearHomeWithinFootprint(enemy, t);
      }
      return;
    }
  } else {
    enemy.retreatStuckSince = null;
  }
  
  enemy.moveCooldown = t + moveCD;
  
  // Update visual to show retreating state
  const el = getEnemyEl(enemy.id);
  if (el && !el.classList.contains('retreating')) {
    el.classList.add('retreating');
  }
}

/**
 * Snap enemy to nearest free tile within their 3×3 footprint.
 * Used when the exact spawn position is blocked.
 * 
 * IMPORTANT: This does NOT finish retreat - it's a "relocation" step.
 * The enemy keeps isRetreating=true and retreatTo unchanged, so they
 * continue moving toward their true spawn point once it's free.
 * 
 * @returns {boolean} True if snapped successfully, false if all tiles blocked
 */
function snapNearHomeWithinFootprint(enemy, t) {
  const spawnX = enemy.spawnX ?? enemy.retreatTo?.x ?? enemy.x;
  const spawnY = enemy.spawnY ?? enemy.retreatTo?.y ?? enemy.y;
  
  // Check all tiles in 3×3 footprint, starting from center
  const offsets = [
    { dx: 0, dy: 0 },   // center first
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
    { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 }
  ];
  
  for (const off of offsets) {
    const testX = spawnX + off.dx;
    const testY = spawnY + off.dy;
    
    if (canEnemyMoveToRetreat(testX, testY, enemy.id)) {
      // Found a free tile - snap to it
      enemy.x = testX;
      enemy.y = testY;
      
      const el = getEnemyEl(enemy.id);
      if (el) {
        el.classList.add('is-teleporting');
        el.style.transform = actorTransform(enemy.x, enemy.y);
        el.offsetHeight;
        requestAnimationFrame(() => {
          el.classList.remove('is-teleporting');
          // Keep 'retreating' class - we're NOT finished yet
        });
      }
      
      // CRITICAL: Do NOT call finishRetreat!
      // - Keep enemy.isRetreating = true
      // - Keep enemy.retreatTo unchanged (still the true spawn point)
      // - Reset stuck timer so we don't re-snap immediately
      enemy.retreatStuckSince = null;
      // Add move cooldown to prevent immediate step
      enemy.moveCooldown = t + 320;
      
      // Track snap for debugging
      retreatStats.nearFootprintSnaps++;
      
      return true;
    }
  }
  
  // All footprint tiles blocked - don't finish retreat, just wait
  // Reset stuck timer to give more time
  enemy.retreatStuckSince = null;
  enemy.moveCooldown = t + 500;
  return false;
}

/**
 * Check if a tile is within an enemy's reserved 3×3 footprint.
 * @param {object} enemy - Enemy with reservedTiles array
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @returns {boolean} True if tile is in enemy's footprint
 */
function isTileInFootprint(enemy, x, y) {
  if (!enemy.reservedTiles || !Array.isArray(enemy.reservedTiles)) {
    // Fallback: check 3×3 around spawn point
    const spawnX = enemy.spawnX ?? enemy.x;
    const spawnY = enemy.spawnY ?? enemy.y;
    return Math.abs(x - spawnX) <= 1 && Math.abs(y - spawnY) <= 1;
  }
  
  for (const tile of enemy.reservedTiles) {
    if (tile.x === x && tile.y === y) return true;
  }
  return false;
}

/**
 * Check if a tile is inside any OTHER living enemy's reserved footprint.
 * Used to prevent pack members from crowding each other's spawn zones during retreat.
 * @param {string} enemyId - ID of the enemy we're moving (excluded from check)
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @returns {boolean} True if tile is in another enemy's footprint
 */
function isTileInAnyOtherFootprint(enemyId, x, y) {
  const enemies = currentState?.runtime?.activeEnemies || [];
  
  for (const other of enemies) {
    // Skip self
    if (other.id === enemyId) continue;
    // Skip dead enemies (their footprint is released)
    if (other.hp <= 0) continue;
    // Skip enemies without footprints
    if (!other.reservedTiles && !other.spawnX) continue;
    
    if (isTileInFootprint(other, x, y)) {
      return true;
    }
  }
  return false;
}

/**
 * Movement check for retreating enemies - footprint-aware.
 * 
 * PHASE 2: This now enforces footprint ownership:
 * - ✅ Allow tile if it's in MY reservedTiles (still must not be occupied)
 * - ❌ Block tile if it's in any OTHER living enemy's reservedTiles
 * 
 * This prevents packs from "crowding" each other's 3×3 zones during retreat,
 * which reduces "destBlocked", "stuck", and snap frequency.
 */
function canEnemyMoveToRetreat(x, y, enemyId) {
  // Basic walkability check
  if (!canMoveTo(currentState, x, y)) return false;
  
  // Don't collide with player
  const player = currentState.player;
  if (player.x === x && player.y === y) return false;
  
  // Don't collide with other enemies (exact position check)
  for (const other of currentState.runtime.activeEnemies || []) {
    if (other.id === enemyId || other.hp <= 0) continue;
    if (other.x === x && other.y === y) return false;
  }
  
  // PHASE 2: Footprint ownership check
  // Get the moving enemy to check if this tile is in their OWN footprint
  const movingEnemy = (currentState.runtime.activeEnemies || []).find(e => e.id === enemyId);
  
  // If tile is in our own footprint, that's fine (we own it)
  if (movingEnemy && isTileInFootprint(movingEnemy, x, y)) {
    return true;
  }
  
  // If tile is in ANOTHER enemy's footprint, block it
  // This prevents pack members from crowding each other's home zones
  if (isTileInAnyOtherFootprint(enemyId, x, y)) {
    return false;
  }
  
  return true;
}

/**
 * Snap enemy to retreat destination (used when stuck as LAST RESORT).
 * Uses unique spawnX/spawnY to avoid clumping at shared locations.
 * If destination is blocked, falls back to nearest free tile in footprint.
 * 
 * NOTE: This function DOES call finishRetreat because we're snapping to
 * the EXACT destination (enemy.x === destX && enemy.y === destY).
 */
function snapEnemyToHome(enemy, t) {
  // CRITICAL: Use retreatTo if set (already unique), else use authoritative spawn point
  // Priority: retreatTo > spawnX/spawnY > home > current position
  const destX = enemy.retreatTo?.x ?? enemy.spawnX ?? enemy.home?.x ?? enemy.x;
  const destY = enemy.retreatTo?.y ?? enemy.spawnY ?? enemy.home?.y ?? enemy.y;
  
  // Check if destination is blocked - if so, use fallback (which does NOT finish retreat)
  if (!canEnemyMoveToRetreat(destX, destY, enemy.id)) {
    snapNearHomeWithinFootprint(enemy, t);
    return;
  }
  
  // Track for debugging
  retreatStats.trueHomeSnaps++;
  
  // Update position in data
  enemy.x = destX;
  enemy.y = destY;
  
  // Update DOM element position immediately with no tween
  const el = getEnemyEl(enemy.id);
  if (el) {
    // Add teleporting class to disable transitions
    el.classList.add('is-teleporting');
    el.style.transform = actorTransform(enemy.x, enemy.y);
    
    // Force reflow then remove class next frame
    el.offsetHeight;
    requestAnimationFrame(() => {
      el.classList.remove('is-teleporting');
      el.classList.remove('retreating');
    });
  }
  
  // This is the only snap path that finishes retreat (because we reached exact dest)
  finishRetreat(enemy, t);
}

/**
 * Finish retreat - enemy has arrived at retreat destination.
 * Resets state IN PLACE - does NOT remove/recreate the enemy.
 */
function finishRetreat(enemy, t) {
  enemy.isRetreating = false;
  enemy.state = AI.STATES.UNAWARE;
  enemy.retreatReason = null;
  enemy.retreatStartedAt = null;
  enemy.retreatStuckSince = null;
  enemy.retreatTo = null; // Clear retreat destination
  enemy._retreatPrevDist = null; // Clear progress tracking
  
  // Clear combat state
  enemy.targetId = null;
  enemy.isEngaged = false;
  enemy.isAware = false;
  enemy.pendingAggro = false; // Clear pending aggro flag
  
  // Full heal on arrival
  const finishMax = getMaxHP(enemy);
  if (finishMax) {
    enemy.hp = finishMax;
    updateEnemyHealthBar(enemy);
  }
  
  // Brief spawn immunity (1.5s)
  enemy.spawnImmunityUntil = t + AI.SPAWN_IMMUNITY_MS;
  
  // Clear provoked status
  provokedEnemies.delete(enemy.id);
  
  // Update visuals
  const el = getEnemyEl(enemy.id);
  if (el) {
    el.classList.remove('retreating');
    el.classList.add('spawn-immune');
    
    // Remove spawn-immune class after immunity expires
    setTimeout(() => {
      el.classList.remove('spawn-immune');
    }, AI.SPAWN_IMMUNITY_MS);
  }
}

/**
 * Move enemy toward home point, respecting pack member footprints.
 */
function moveEnemyTowardHome(enemy, targetX, targetY) {
  const t = nowMs();
  
  // Movement cooldown
  const moveCD = 400 * (enemy.isRetreating ? 0.8 : 1);
  if (!isExpired(enemy.moveCooldown, t)) return;
  
  const dx = Math.sign(targetX - enemy.x);
  const dy = Math.sign(targetY - enemy.y);
  
  const moves = [];
  if (dx !== 0 && dy !== 0) moves.push({ x: enemy.x + dx, y: enemy.y + dy });
  if (dx !== 0) moves.push({ x: enemy.x + dx, y: enemy.y });
  if (dy !== 0) moves.push({ x: enemy.x, y: enemy.y + dy });
  
  // First pass: prefer moves that don't enter pack member footprints
  for (const move of moves) {
    if (canEnemyMoveToEx(move.x, move.y, enemy, true)) {
      updateEnemyPosition(enemy, move.x, move.y);
      enemy.moveCooldown = t + moveCD;
      return;
    }
  }
  
  // Second pass: allow footprint entry if necessary (still check corner cutting)
  for (const move of moves) {
    if (canEnemyMoveFromTo(enemy, move.x, move.y)) {
      updateEnemyPosition(enemy, move.x, move.y);
      enemy.moveCooldown = t + moveCD;
      return;
    }
  }
  
  enemy.moveCooldown = t + moveCD;
}

/**
 * Execute combat AI based on enemy type.
 * 
 * NOTE: Spawn settle is checked here - enemies can aggro/detect during settle,
 * but cannot attack. They will move into position during settle period.
 */
function executeCombatAI(enemy, weapon, dPlayer, hasLOS, t, config) {
  // Check spawn settle - can move/position but cannot attack yet
  const inSettle = isInSpawnSettle(enemy, t);

  switch (config.aiType) {
    case 'melee':
      aiMelee(enemy, weapon, dPlayer, hasLOS, t, inSettle);
      break;
    case 'ranged':
      aiRanged(enemy, weapon, dPlayer, hasLOS, t, inSettle);
      break;
    case 'aggressive':
      aiAggressive(enemy, weapon, dPlayer, hasLOS, t, inSettle);
      break;
    case 'guard':
      // Guards don't chase
      break;
    default:
      aiMelee(enemy, weapon, dPlayer, hasLOS, t, inSettle);
  }
}

// Note: hasSpawnImmunity is imported from aiUtils.js as checkSpawnImmunity
// No local wrapper needed - use the imported function directly

/**
 * Update enemy visuals (health bars, retreat indicators, passive state)
 * This is the authoritative visual update function.
 * 
 * OPTIMIZATION: Uses cached DOM refs and dirty-flags to avoid redundant DOM writes.
 * OPTIMIZATION: Skips enemies far from player (off-screen, no visual changes needed).
 */
const VISUAL_UPDATE_RANGE = 25; // Only update visuals for enemies within this tile range

function updateEnemyVisuals() {
  if (!currentState?.runtime?.activeEnemies) return;
  
  perfStart('enemy:updateVisuals');
  
  const t = nowMs();
  const px = currentState.player.x;
  const py = currentState.player.y;
  
  for (const enemy of currentState.runtime.activeEnemies) {
    if (enemy.hp <= 0) continue;
    
    // Skip distant enemies (they're off-screen, visual updates don't matter)
    const dx = Math.abs(enemy.x - px);
    const dy = Math.abs(enemy.y - py);
    if (dx > VISUAL_UPDATE_RANGE || dy > VISUAL_UPDATE_RANGE) continue;
    
    // Use cached DOM reference
    const el = getEnemyEl(enemy.id);
    if (!el) continue;
    
    // Calculate current visual state
    const retreating = !!enemy.isRetreating;
    const engaged = !!(enemy.isEngaged || enemy.state === 'ENGAGED');
    const immuneRemaining = getSpawnImmunityRemaining(enemy, t);
    const spawnImmune = immuneRemaining > 0;
    const passive = isEnemyPassive(enemy) && !provokedEnemies.has(enemy.id);
    
    // Get previous state (for dirty-flag comparison)
    const prev = enemyVisualState.get(enemy.id);
    
    // Only update DOM if state changed
    if (!prev || prev.retreating !== retreating) {
      el.classList.toggle('retreating', retreating);
    }
    
    if (!prev || prev.engaged !== engaged) {
      el.classList.toggle('engaged', engaged);
    }
    
    if (!prev || prev.spawnImmune !== spawnImmune) {
      el.classList.toggle('spawn-immune', spawnImmune);
    }
    
    if (!prev || prev.passive !== passive) {
      el.classList.toggle('passive', passive);
      if (passive) {
        el.dataset.passive = 'true';
      } else {
        delete el.dataset.passive;
      }
      
      // Update badge if present (only when passive state changes)
      const badge = el.querySelector('.enemy-level-badge');
      if (badge) {
        badge.classList.toggle('passive-badge', passive);
      }
    }
    
    // Store current state for next comparison
    enemyVisualState.set(enemy.id, { retreating, engaged, spawnImmune, passive });
  }
  
  perfEnd('enemy:updateVisuals');
}

// Idle behavior - small random patrol movements
function aiIdle(enemy, now, weapon) {
  const moveCD = (weapon?.moveSpeed || DEFAULT_MOVE_COOLDOWN) * 3; // Move slower when idle
  
  // Pick a random adjacent tile
  const directions = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 }
  ];
  
  const dir = directions[Math.floor(Math.random() * directions.length)];
  const newX = enemy.x + dir.dx;
  const newY = enemy.y + dir.dy;
  
  // Stay within 3×3 footprint (soft personal space)
  // With spawn footprint system, enemy's spawn point is center of their exclusive 3×3 block
  // They should wander at most 1 tile from center (stays inside footprint)
  if (enemy.spawnX !== undefined && enemy.spawnY !== undefined) {
    const distFromSpawn = Math.max(
      Math.abs(newX - enemy.spawnX),
      Math.abs(newY - enemy.spawnY)
    );
    
    // Stay within footprint (Chebyshev distance <= 1 for 3×3 block)
    if (distFromSpawn > 1) {
      // Move back toward spawn instead
      const toSpawnX = Math.sign(enemy.spawnX - enemy.x);
      const toSpawnY = Math.sign(enemy.spawnY - enemy.y);
      if (canEnemyMoveTo(enemy.x + toSpawnX, enemy.y + toSpawnY, enemy)) {
        updateEnemyPosition(enemy, enemy.x + toSpawnX, enemy.y + toSpawnY, false, true); // idle=true
      }
      enemy.moveCooldown = now + moveCD;
      return;
    }
  }
  
  if (canEnemyMoveTo(newX, newY, enemy)) {
    updateEnemyPosition(enemy, newX, newY, false, true); // idle=true
  }
  
  enemy.moveCooldown = now + moveCD;
}

// Check if an enemy is passive (yellow nomad/critter)
function isEnemyPassive(enemy) {
  // New system: check aggroType from spawn director
  if (enemy.aggroType === 'passive') return true;
  if (enemy.aggroType === 'aggressive') return false;
  if (enemy.aggroType === 'conditional') {
    // Conditional becomes aggressive in Act 3 or when provoked
    const isAct3 = currentState?.flags?.act3;
    if (isAct3) return false;
  }
  
  // Legacy fallback: nomads and critters are passive by default
  return (enemy.type === 'nomad' || enemy.type === 'critter') && enemy.level < PASSIVE_CRITTER_MAX_LEVEL;
}

/**
 * Provoke an enemy (called when player attacks it).
 * 
 * NEW SEMANTICS:
 * - Sets provokedUntil timer (15s) for aggro persistence
 * - If canAggro, transitions immediately to ENGAGED
 * - If brokenOff/retreating, sets pendingAggro flag
 * - Aggros entire pack
 * 
 * @param {object} enemy - Enemy to provoke
 * @param {number} t - Current time (performance.now)
 * @param {string} reason - Why provoked: 'player_attack', 'pack', 'area'
 */
export function provokeEnemy(enemy, t = nowMs(), reason = 'player_attack') {
  if (!enemy || enemy.hp <= 0) return;
  
  // Skip if already provoked (prevents infinite recursion)
  if (provokedEnemies.has(enemy.id) && !isExpired(enemy.provokedUntil, t)) {
    return;
  }
  
  // Mark as provoked for 15 seconds
  provokedEnemies.add(enemy.id);
  enemy.provokedUntil = t + 15000;
  enemy.provokeReason = reason;
  
  // Can we aggro immediately?
  if (canAggro(enemy, t)) {
    // Transition to ENGAGED immediately
    enemy.isAware = true;
    enemy.awareTime = t - AI.ALERT_DURATION_MS; // Skip alert delay
    enemy.lastSeenPlayer = t;
    enemy.isEngaged = true;
    enemy.state = AI.STATES.ENGAGED;
    enemy.targetId = 'player';
    enemy.pendingAggro = false;
  } else {
    // Can't aggro yet (broken off, retreating) - set pending
    enemy.pendingAggro = true;
  }
  
  // Aggro the entire pack (only on initial provoke, not pack propagation)
  if (reason === 'player_attack') {
    aggroPack(enemy, t);
  }
  
  updateEnemyVisuals();
}

/**
 * Aggro all members of an enemy's pack.
 */
function aggroPack(enemy, t = nowMs()) {
  // Use packId (new system) or fall back to spawnId (old system)
  const packKey = enemy.packId || enemy.spawnId;
  if (!packKey) return;
  
  const packMembers = currentState.runtime.activeEnemies.filter(e => {
    if (e.hp <= 0) return false;
    if (e.id === enemy.id) return false; // Skip the original (already provoked)
    // Match by packId (new system) or spawnId (legacy)
    return (e.packId && e.packId === enemy.packId) || 
           (e.spawnId && e.spawnId === enemy.spawnId);
  });
  
  for (const member of packMembers) {
    // Provoke pack member (but with 'pack' reason)
    provokeEnemy(member, t, 'pack');
  }
}

// Note: shouldBreakOffFromGuards is now imported from aiUtils.js

// ============================================
// MELEE AI - Surround and take turns
// ============================================
function aiMelee(enemy, weapon, dist, hasLOS, t, inSettle = false) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  // Can we attack?
  if (dist <= weapon.range && hasLOS) {
    // Check if it's our turn to attack (rotate through melee attackers)
    if (canMeleeAttack(enemy, t)) {
      // Spawn settle blocks attacks but not positioning
      if (inSettle) {
        // Just hold position, don't attack yet
        return;
      }
      if (isExpired(enemy.cooldownUntil, t)) {
        enemyAttack(enemy, weapon, t);
        lastMeleeAttacker = enemy.id;
      }
    } else {
      // Not our turn - only reposition occasionally, not constantly
      if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.3) {
        moveToSurroundPosition(enemy);
        enemy.moveCooldown = t + moveCD * 1.5;
      }
    }
  } else if (hasLOS) {
    // Have LOS but not in range - advance toward player
    if (isExpired(enemy.moveCooldown, t)) {
      moveTowardPlayer(enemy);
      enemy.moveCooldown = t + moveCD;
    }
  } else {
    // No LOS - try to find a path, but don't move constantly
    if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.5) {
      moveToGetLOS(enemy);
      enemy.moveCooldown = t + moveCD * 1.2;
    }
  }
}

/**
 * Check if enemy can engage (acquire attacker slot).
 * Uses lease-based system to prevent deadlocks.
 */
function canEnemyEngage(enemy, t = nowMs()) {
  return acquireAttackerSlot(enemy, t);
}

/**
 * Legacy compatibility wrapper.
 */
function canMeleeAttack(enemy, t = nowMs()) {
  return canEnemyEngage(enemy, t);
}

// Move to a position that surrounds the player
function moveToSurroundPosition(enemy) {
  const player = currentState.player;
  
  // Get positions around the player
  const surroundPositions = [
    { x: player.x - 1, y: player.y },
    { x: player.x + 1, y: player.y },
    { x: player.x, y: player.y - 1 },
    { x: player.x, y: player.y + 1 },
    { x: player.x - 1, y: player.y - 1 },
    { x: player.x + 1, y: player.y - 1 },
    { x: player.x - 1, y: player.y + 1 },
    { x: player.x + 1, y: player.y + 1 }
  ];
  
  // Shuffle to prevent clumping on same side
  shuffleArray(surroundPositions);
  
  // Find an unoccupied position, preferring ones outside pack footprints
  for (const pos of surroundPositions) {
    if (canEnemyMoveTo(pos.x, pos.y, enemy.id)) {
      // Move toward this position
      const dx = Math.sign(pos.x - enemy.x);
      const dy = Math.sign(pos.y - enemy.y);
      
      const moves = [
        { x: enemy.x + dx, y: enemy.y + dy },
        { x: enemy.x + dx, y: enemy.y },
        { x: enemy.x, y: enemy.y + dy }
      ];
      
      // First pass: prefer moves outside pack footprints
      for (const move of moves) {
        if (canEnemyMoveToEx(move.x, move.y, enemy, true)) {
          updateEnemyPosition(enemy, move.x, move.y);
          return;
        }
      }
      
      // Second pass: allow footprint entry if needed (still check corner cutting)
      for (const move of moves) {
        if (canEnemyMoveFromTo(enemy, move.x, move.y)) {
          updateEnemyPosition(enemy, move.x, move.y);
          return;
        }
      }
    }
  }
}

// Move to a flanking position (for ranged enemies waiting to engage)
function moveToFlankPosition(enemy) {
  const player = currentState.player;
  
  // Find positions at range 3-5 from player in different directions
  const flankPositions = [];
  for (let angle = 0; angle < 8; angle++) {
    const rad = (angle / 8) * Math.PI * 2;
    for (let dist = 3; dist <= 5; dist++) {
      const x = Math.round(player.x + Math.cos(rad) * dist);
      const y = Math.round(player.y + Math.sin(rad) * dist);
      flankPositions.push({ x, y });
    }
  }
  
  // Shuffle and find a valid position
  shuffleArray(flankPositions);
  
  for (const pos of flankPositions) {
    if (canEnemyMoveTo(pos.x, pos.y, enemy.id)) {
      // Move one step toward this position
      const dx = Math.sign(pos.x - enemy.x);
      const dy = Math.sign(pos.y - enemy.y);
      
      if (dx !== 0 || dy !== 0) {
        const moves = [
          { x: enemy.x + dx, y: enemy.y + dy },
          { x: enemy.x + dx, y: enemy.y },
          { x: enemy.x, y: enemy.y + dy }
        ];
        
        // First pass: prefer moves outside pack footprints
        for (const move of moves) {
          if (canEnemyMoveToEx(move.x, move.y, enemy, true)) {
            updateEnemyPosition(enemy, move.x, move.y);
            return;
          }
        }
        
        // Second pass: allow footprint entry if needed (still check corner cutting)
        for (const move of moves) {
          if (canEnemyMoveFromTo(enemy, move.x, move.y)) {
            updateEnemyPosition(enemy, move.x, move.y);
            return;
          }
        }
      }
    }
  }
}

// ============================================
// RANGED AI - Maintain distance, kite
// ============================================
function aiRanged(enemy, weapon, dist, hasLOS, t, inSettle = false) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  const attackRange = weapon.range || RANGED_RANGE;
  
  // If player is too close (within melee range), retreat immediately
  // This is critical for ranged enemies to maintain their distance band
  if (dist < RANGED_MIN_DISTANCE && isExpired(enemy.moveCooldown, t)) {
    moveAwayFromPlayer(enemy);
    enemy.moveCooldown = t + moveCD;
    return;
  }
  
  // In attack range with LOS - check if we can engage (max 2 attackers)
  if (dist <= attackRange && dist >= RANGED_MIN_DISTANCE && hasLOS) {
    if (canEnemyEngage(enemy, t)) {
      // Spawn settle blocks attacks
      if (inSettle) {
        return;
      }
      if (isExpired(enemy.cooldownUntil, t)) {
        enemyAttack(enemy, weapon, t);
      }
    } else {
      // Can't engage - find a different angle/position and wait
      if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.3) {
        moveToFlankPosition(enemy);
        enemy.moveCooldown = t + moveCD * 1.5;
      }
    }
    return;
  }
  
  // No LOS - try to reposition, but not frantically
  if (!hasLOS) {
    if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.4) {
      moveToGetLOS(enemy);
      enemy.moveCooldown = t + moveCD * 1.3;
    }
    return;
  }
  
  // Out of range with LOS - advance to preferred distance
  if (dist > attackRange && isExpired(enemy.moveCooldown, t) && Math.random() < 0.6) {
    moveTowardPlayerRanged(enemy, attackRange);
    enemy.moveCooldown = t + moveCD;
  }
}

// ============================================
// AGGRESSIVE AI - For bosses and alphas
// ============================================
function aiAggressive(enemy, weapon, dist, hasLOS, t, inSettle = false) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  if (dist <= weapon.range && hasLOS) {
    // Spawn settle blocks attacks
    if (inSettle) {
      return;
    }
    if (isExpired(enemy.cooldownUntil, t)) {
      enemyAttack(enemy, weapon, t);
    }
  } else {
    if (isExpired(enemy.moveCooldown, t)) {
      moveTowardPlayer(enemy);
      enemy.moveCooldown = t + moveCD;
    }
  }
}

// Note: aiRetreatFromGuards removed - now using startRetreat() + processRetreat() from aiUtils.js

// ============================================
// ENEMY MOVEMENT
// ============================================
function moveTowardPlayer(enemy) {
  const player = currentState.player;
  const dx = Math.sign(player.x - enemy.x);
  const dy = Math.sign(player.y - enemy.y);
  
  // Alternate between horizontal/vertical to spread out
  const preferHorizontal = enemy.id.charCodeAt(enemy.id.length - 1) % 2 === 0;
  
  let moves;
  if (preferHorizontal) {
    moves = [
      { x: enemy.x + dx, y: enemy.y },
      { x: enemy.x, y: enemy.y + dy },
      { x: enemy.x + dx, y: enemy.y + dy }
    ];
  } else {
    moves = [
      { x: enemy.x, y: enemy.y + dy },
      { x: enemy.x + dx, y: enemy.y },
      { x: enemy.x + dx, y: enemy.y + dy }
    ];
  }

  // First pass: prefer moves that don't enter pack member footprints
  for (const move of moves) {
    if (canEnemyMoveToEx(move.x, move.y, enemy, true)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
  
  // Second pass: allow entering footprints if necessary (still check corner cutting)
  for (const move of moves) {
    if (canEnemyMoveFromTo(enemy, move.x, move.y)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
}

function moveTowardPlayerRanged(enemy, maxRange) {
  const player = currentState.player;
  const currentDist = distCoords(enemy.x, enemy.y, player.x, player.y);
  const preferredDist = maxRange - 2;
  
  if (currentDist <= preferredDist) return; // Already in good position
  
  const dx = Math.sign(player.x - enemy.x);
  const dy = Math.sign(player.y - enemy.y);
  
  const moves = [
    { x: enemy.x + dx, y: enemy.y },
    { x: enemy.x, y: enemy.y + dy },
    { x: enemy.x + dx, y: enemy.y + dy }
  ];

  // First pass: prefer moves outside pack footprints
  for (const move of moves) {
    const newDist = distCoords(move.x, move.y, player.x, player.y);
    if (newDist >= preferredDist - 1 && canEnemyMoveToEx(move.x, move.y, enemy, true)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
  
  // Second pass: allow footprint entry if needed (still check corner cutting)
  for (const move of moves) {
    const newDist = distCoords(move.x, move.y, player.x, player.y);
    if (newDist >= preferredDist - 1 && canEnemyMoveFromTo(enemy, move.x, move.y)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
}

function moveAwayFromPlayer(enemy) {
  const player = currentState.player;
  moveAwayFrom(enemy, player.x, player.y);
}

function moveAwayFrom(enemy, targetX, targetY) {
  const dx = Math.sign(enemy.x - targetX);
  const dy = Math.sign(enemy.y - targetY);
  
  const moves = [
    { x: enemy.x + dx, y: enemy.y + dy },
    { x: enemy.x + dx, y: enemy.y },
    { x: enemy.x, y: enemy.y + dy },
    { x: enemy.x - dy, y: enemy.y + dx }, // Perpendicular
    { x: enemy.x + dy, y: enemy.y - dx }
  ];

  // First pass: prefer moves outside pack footprints
  for (const move of moves) {
    if (canEnemyMoveToEx(move.x, move.y, enemy, true)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
  
  // Second pass: allow footprint entry if needed (still check corner cutting)
  for (const move of moves) {
    if (canEnemyMoveFromTo(enemy, move.x, move.y)) {
      updateEnemyPosition(enemy, move.x, move.y);
      return;
    }
  }
}

function moveToGetLOS(enemy) {
  const player = currentState.player;
  const directions = shuffleArray([
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
  ]);

  // First pass: prefer moves outside pack footprints
  for (const dir of directions) {
    const nx = enemy.x + dir.dx;
    const ny = enemy.y + dir.dy;
    if (canEnemyMoveToEx(nx, ny, enemy, true)) {
      if (hasLineOfSight(currentState, nx, ny, player.x, player.y)) {
        updateEnemyPosition(enemy, nx, ny);
        return;
      }
    }
  }
  
  // Second pass: allow footprint entry if needed
  for (const dir of directions) {
    const nx = enemy.x + dir.dx;
    const ny = enemy.y + dir.dy;
    if (canEnemyMoveTo(nx, ny, enemy.id)) {
      if (hasLineOfSight(currentState, nx, ny, player.x, player.y)) {
        updateEnemyPosition(enemy, nx, ny);
        return;
      }
    }
  }

  // No LOS found, just move toward player
  moveTowardPlayer(enemy);
}

function canEnemyMoveTo(x, y, excludeId) {
  if (!canMoveTo(currentState, x, y)) return false;
  if (x === currentState.player.x && y === currentState.player.y) return false;

  // Don't walk on other enemies (but can be adjacent - no gap required in combat)
  for (const other of currentState.runtime.activeEnemies) {
    if (other.id === excludeId) continue;
    if (other.hp <= 0) continue;
    
    // Only block if trying to occupy the exact same tile
      if (other.x === x && other.y === y) return false;
  }

  return true;
}

/**
 * Check if enemy can move from current position to target, including corner check.
 * Use this for movement decisions where diagonal moves are possible.
 */
function canEnemyMoveFromTo(enemy, toX, toY) {
  if (!canEnemyMoveTo(toX, toY, enemy.id)) return false;
  if (wouldEnemyCutCorner(enemy.x, enemy.y, toX, toY, enemy.id)) return false;
  return true;
}

/**
 * Check if a tile is inside another pack member's 3×3 footprint.
 * @param {object} enemy - The enemy trying to move
 * @param {number} x - Target x coordinate
 * @param {number} y - Target y coordinate
 * @returns {boolean} True if tile is in a pack member's footprint
 */
function isInPackMemberFootprint(enemy, x, y) {
  if (!enemy.packId) return false; // Solo enemies don't have pack footprint concerns
  
  for (const other of currentState.runtime.activeEnemies || []) {
    if (other.id === enemy.id) continue;
    if (other.hp <= 0) continue;
    if (other.packId !== enemy.packId) continue; // Only check same pack
    
    // Check if (x,y) is within other's 3×3 footprint (Chebyshev distance <= 1 from spawn)
    const spawnX = other.spawnX ?? other.x;
    const spawnY = other.spawnY ?? other.y;
    const dx = Math.abs(x - spawnX);
    const dy = Math.abs(y - spawnY);
    
    if (dx <= 1 && dy <= 1) {
      return true; // This tile is in another pack member's footprint
    }
  }
  
  return false;
}

/**
 * Check if a diagonal move would cut through a corner (for enemies).
 * For diagonal moves, both adjacent cardinal directions must be passable.
 */
function wouldEnemyCutCorner(fromX, fromY, toX, toY, enemyId) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  
  // Only check for diagonal moves
  if (dx === 0 || dy === 0) return false;
  
  // Check the two cardinal tiles adjacent to the diagonal path
  const horizontalBlocked = !canEnemyMoveTo(fromX + dx, fromY, enemyId);
  const verticalBlocked = !canEnemyMoveTo(fromX, fromY + dy, enemyId);
  
  return horizontalBlocked || verticalBlocked;
}

/**
 * Check if enemy can move to tile, with optional footprint avoidance.
 * @param {number} x - Target x
 * @param {number} y - Target y
 * @param {object} enemy - The enemy (object, not just ID)
 * @param {boolean} respectFootprints - If true, avoid pack member footprints
 * @returns {boolean} True if move is allowed
 */
function canEnemyMoveToEx(x, y, enemy, respectFootprints = false) {
  // Basic movement check
  if (!canEnemyMoveTo(x, y, enemy.id)) return false;
  
  // Corner cutting check for diagonal moves
  if (wouldEnemyCutCorner(enemy.x, enemy.y, x, y, enemy.id)) return false;
  
  // Footprint check (if requested)
  if (respectFootprints && isInPackMemberFootprint(enemy, x, y)) {
    return false;
  }
  
  return true;
}

function updateEnemyPosition(enemy, x, y, forceMove = false, isIdle = false) {
  // Stunned or rooted enemies can't move (unless retreating or forced)
  if (!forceMove && !enemy.isRetreating && (isStunned(enemy) || isRooted(enemy))) {
    return;
  }
  
  enemy.x = x;
  enemy.y = y;

  const el = getEnemyEl(enemy.id);
  if (el) {
    // Idle movement uses slower transition (2x duration)
    if (isIdle) {
      el.classList.add('idle');
    } else {
      el.classList.remove('idle');
    }
    
    el.style.transform = actorTransform(x, y);
    
    // Add moving class for walk animation
    el.classList.add('moving');
    
    // Remove after transition (read from CSS var or use default, 2.5x for idle)
    const moveSpeed = parseInt(el.dataset.moveSpeed) || 400;
    const duration = isIdle ? moveSpeed * 2.5 : moveSpeed;
    clearTimeout(enemy._moveTimeout);
    enemy._moveTimeout = setTimeout(() => {
      el.classList.remove('moving');
    }, duration);
    
    // Add/remove retreating class for visual feedback
    if (enemy.isRetreating) {
      el.classList.add('retreating');
    } else {
      el.classList.remove('retreating');
    }
  }
}

// ============================================
// ENEMY DAMAGE CALCULATION (Plan B Unified)
// ============================================
/**
 * Calculate damage from enemy to player using unified formula.
 * Alpha damage bonus is now baked into enemy.atk at spawn time.
 */
function calculateEnemyDamage(enemy, weapon, player) {
  const { damage } = computeDamage({
    attacker: enemy,
    defender: player,
    defenderConfig: null, // Player has no type weakness
    baseDamage: weapon.baseDamage || 10,
    skillMult: weapon.multiplier || 1,
    damageType: weapon.damageType || null,
    forceNoCrit: true, // Enemies don't crit (for now)
    source: "enemy",
    attackId: weapon.id || weapon.name || "attack",
    attackerName: enemy.name || enemy.type
  });
  
  return damage;
}

// ============================================
// ENEMY ATTACK
// ============================================
/**
 * Execute an enemy attack on the player.
 * Uses performance time and releases attacker slot on failure.
 * 
 * @param {object} enemy - Attacking enemy
 * @param {object} weapon - Enemy weapon config
 * @param {number} t - Current time (performance.now)
 */
function enemyAttack(enemy, weapon, t = nowMs()) {
  // Can't attack ghost or immune player - release slot
  if (isGhostMode || playerImmunityActive) {
    releaseAttackerSlot(enemy);
    return;
  }
  
  const player = currentState.player;

  // No LOS - release slot so others can attack
  if (!hasLineOfSight(currentState, enemy.x, enemy.y, player.x, player.y)) {
    releaseAttackerSlot(enemy);
    return;
  }

  // Spawn settle check - can't attack yet
  if (isInSpawnSettle(enemy, t)) {
    // Don't release slot - enemy will attack soon
    return;
  }

  // Execute attack
  let damage = calculateEnemyDamage(enemy, weapon, player);

  if (weapon.type === 'ranged') {
    showProjectile(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || getColors().projectileEnemy);
  } else {
    showMeleeSwipe(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || getColors().projectileEnemy);
  }

  player.hp -= damage;
  lastHitTime = t;
  markCombatEvent(t); // Track combat activity for regen gating

  showDamageNumber(player.x, player.y, damage, false, true);
  logCombat(`${enemy.name} hits you for ${damage}!`);

  // Set cooldown using perf time
  enemy.cooldownUntil = t + weapon.cooldown;

  // Renew attacker lease (successful attack)
  acquireAttackerSlot(enemy, t);

  if (!currentTarget || currentTarget.hp <= 0) {
    autoTargetClosestAttacker();
  }

  updatePlayerHealthBar();

  if (player.hp <= 0) {
    handlePlayerDeath();
  }
}

function autoTargetClosestAttacker() {
  const player = currentState.player;
  const enemies = currentState.runtime.activeEnemies.filter(e => e.hp > 0 && e.isEngaged);
  
  if (enemies.length === 0) return;
  
  enemies.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  selectTarget(enemies[0]);
}

// ============================================
// PLAYER ATTACK (legacy - delegates to intent system)
// ============================================
export function playerAttack() {
  if (isGhostMode) {
    logCombat('You are a spirit... find your corpse to revive.');
    return;
  }
  
  if (playerImmunityActive) {
    logCombat('Recovering... actions disabled during immunity.');
    return;
  }
  
  if (!currentTarget || currentTarget.hp <= 0) {
    logCombat('No target selected. Press Tab to target.');
    return;
  }

  // Delegate to the new intent system for basic attacks
  const result = setAutoAttackIntent(currentTarget);
  if (!result.success) {
    if (result.reason === 'retreating') {
      logCombat('Target is retreating.');
    } else if (result.reason === 'dead') {
      logCombat('Target is dead.');
    } else {
      logCombat('Invalid target.');
    }
    clearTarget();
    return;
  }
  
  autoAttackEnabled = true;
  inCombat = true;
  tryExecuteCombatIntent();
}

async function moveToAttackRange(target, range, actionType) {
  logCombat(`Moving to range...`);
  pendingAttack = { target, range, actionType };
  
  const { createPathTo } = await import('./movement.js');
  
  const player = currentState.player;
  const bestTile = findTileInRange(player.x, player.y, target.x, target.y, range);
  
  if (bestTile) {
    createPathTo(bestTile.x, bestTile.y, false);
  } else {
    logCombat('Cannot find path to target');
    pendingAttack = null;
  }
}

function findTileInRange(fromX, fromY, targetX, targetY, range) {
  const candidates = [];
  
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      const x = targetX + dx;
      const y = targetY + dy;
      const distToTarget = distCoords(x, y, targetX, targetY);
      
      if (distToTarget <= range && distToTarget > 0) {
        if (canMoveTo(currentState, x, y)) {
          const distFromPlayer = distCoords(fromX, fromY, x, y);
          candidates.push({ x, y, dist: distFromPlayer });
        }
      }
    }
  }
  
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0] || null;
}

/**
 * Check if player has arrived in range for a pending attack.
 * Called every frame from game loop.
 * 
 * NOTE: This bridges the legacy action system with the intent system.
 * - If there's a combatIntent, the intent system owns execution
 * - Legacy paths (useAction, numbered keys) create pendingAttack
 * - When arriving in range, we route to the appropriate handler
 */
export function checkPendingAttack() {
  // If there's an active combat intent, let the intent system handle execution
  // This prevents race conditions between the two systems
  if (combatIntent) {
    pendingAttack = null; // Intent system owns execution
    return;
  }
  
  if (!pendingAttack) return;
  
  // Validate target
  const targetCheck = isInvalidCombatTarget(pendingAttack.target, nowMs());
  if (targetCheck.invalid) {
    pendingAttack = null;
    return;
  }

  const player = currentState.player;
  const targetDist = distCoords(player.x, player.y, pendingAttack.target.x, pendingAttack.target.y);
  
  // Not in range yet - keep waiting
  if (targetDist > pendingAttack.range) return;
  
  // Check LOS
  if (!hasLineOfSight(currentState, player.x, player.y, pendingAttack.target.x, pendingAttack.target.y)) {
    return; // No LOS - keep moving
  }
  
  // In range with LOS - execute
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) {
    pendingAttack = null;
    return;
  }
  
  const actionType = pendingAttack.actionType;
  pendingAttack = null; // Clear before executing to prevent re-entry
  
  // Route to appropriate handler
  if (actionType === 'basic' || actionType === 'attack') {
    // Basic attack - use intent system
    if (currentTarget && currentTarget.hp > 0) {
      setAutoAttackIntent(currentTarget);
      tryExecuteCombatIntent();
    }
  } else if (actionType.startsWith('weaponAbility_')) {
    // Weapon ability from intent system - execute directly
    const slot = parseInt(actionType.split('_')[1], 10);
    if (!isNaN(slot) && actionCooldowns[slot] <= 0) {
      executeWeaponAbilityDirect(slot);
      // Resume auto-attack after ability
      if (autoAttackEnabled && currentTarget?.hp > 0) {
        setAutoAttackIntent(currentTarget);
      }
    }
  } else {
    // Legacy numbered action keys (1, 2, 3) - route through useAction
    // TODO: Migrate useAction callers to useWeaponAbility for full intent system coverage
    const keyNum = parseInt(actionType, 10);
    if (!isNaN(keyNum) && keyNum >= 1 && keyNum <= 3 && actionCooldowns[keyNum] <= 0) {
      useAction(keyNum);
    }
  }
}

/**
 * Legacy action handler for weapon abilities (slots 1-3).
 * 
 * TECH DEBT: This predates the intent system and handles its own move-to-range.
 * New code should use useWeaponAbility() which creates proper intents.
 * 
 * Still used by:
 * - playerSpecial() → calls useAction('3')
 * - checkPendingAttack() → legacy numbered key handling
 * - handleTargeting('action', data) → legacy action case
 */
export function useAction(actionKey) {
  if (isGhostMode) {
    logCombat('You are a spirit... find your corpse to revive.');
    return;
  }
  
  if (playerImmunityActive) {
    logCombat('Recovering... actions disabled during immunity.');
    return;
  }
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) {
    logCombat('No weapon equipped');
    return;
  }

  // Normalize key to integer for consistent cooldown handling
  const keyNum = parseInt(actionKey);
  if (isNaN(keyNum) || keyNum < 1 || keyNum > 3) {
    logCombat('Invalid action key');
    return;
  }
  
  const actionIndex = keyNum - 1;
  const action = weapon.actions?.[actionIndex];
  if (!action) {
    logCombat('Action not available');
    return;
  }

  // Check cooldown using integer key
  if (actionCooldowns[keyNum] > 0) {
    const remaining = (actionCooldowns[keyNum] / 1000).toFixed(1);
    logCombat(`${action.name} on cooldown (${remaining}s)`);
    return;
  }

  // If no target, find nearest enemy and move to attack
  if (!currentTarget || currentTarget.hp <= 0) {
    const nearbyEnemy = findNearestEnemy();
    if (nearbyEnemy) {
      selectTarget(nearbyEnemy);
      logCombat(`Targeting ${nearbyEnemy.name}`);
      
      // Start auto-attack and move to range
      autoAttackEnabled = true;
      inCombat = true;
      
      const player = currentState.player;
      const targetDist = distCoords(player.x, player.y, nearbyEnemy.x, nearbyEnemy.y);
      
      if (targetDist > weapon.range) {
        moveToAttackRange(nearbyEnemy, weapon.range, String(keyNum));
        return;
      }
    } else {
      logCombat('No enemies nearby');
      return;
    }
  }

  const player = currentState.player;

  switch (action.type) {
    case 'attack':
      autoAttackEnabled = true;
      inCombat = true;
      playerAttack();
      return;

    case 'aimed':
    case 'heavy':
      if (!currentTarget || currentTarget.hp <= 0) {
        logCombat('No target');
        return;
      }
      // Move to range if needed
      if (!checkRangeAndLOS(weapon, String(keyNum))) return;
      
      // Enable auto-attack - combat has started
      autoAttackEnabled = true;
      inCombat = true;
      
      provokeEnemy(currentTarget);
      executeEnhancedAttack(weapon, action);
      actionCooldowns[keyNum] = action.cooldown;
      actionMaxCooldowns[keyNum] = action.cooldown;
      break;

    case 'double':
      if (!currentTarget || currentTarget.hp <= 0) {
        logCombat('No target');
        return;
      }
      // Move to range if needed
      if (!checkRangeAndLOS(weapon, String(keyNum))) return;
      
      // Enable auto-attack - combat has started
      autoAttackEnabled = true;
      inCombat = true;
      
      provokeEnemy(currentTarget);
      executeDoubleAttack(weapon, action);
      actionCooldowns[keyNum] = action.cooldown;
      actionMaxCooldowns[keyNum] = action.cooldown;
      break;

    case 'special':
    case 'rapid':
      if (action.senseCost && player.sense < action.senseCost) {
        logCombat('Not enough Sense');
        return;
      }
      if (!currentTarget || currentTarget.hp <= 0) {
        logCombat('No target');
        return;
      }
      // Move to range if needed
      if (!checkRangeAndLOS(weapon, String(keyNum))) return;

      // Enable auto-attack - combat has started
      autoAttackEnabled = true;
      inCombat = true;
      
      provokeEnemy(currentTarget);
      if (action.shots) {
        executeRapidFire(weapon, action);
      } else {
        if (action.senseCost) {
        player.sense -= action.senseCost;
        updatePlayerSenseBar();
      }
        executeEnhancedAttack(weapon, action);
      }
      actionCooldowns[keyNum] = action.cooldown;
      actionMaxCooldowns[keyNum] = action.cooldown;
      break;

    case 'cleave':
      if (action.senseCost && player.sense < action.senseCost) {
        logCombat('Not enough Sense');
        return;
      }
      // Enable auto-attack - combat has started
      autoAttackEnabled = true;
      inCombat = true;
      
      // Spend sense before executing (consistent with other actions)
      if (action.senseCost) {
        player.sense = Math.max(0, player.sense - action.senseCost);
        updatePlayerSenseBar();
      }
      
      executeCleave(weapon, action);
      actionCooldowns[keyNum] = action.cooldown;
      actionMaxCooldowns[keyNum] = action.cooldown;
      break;

    case 'dash':
      if (!currentTarget || currentTarget.hp <= 0) {
        logCombat('No target');
        return;
      }
      // Dash has extended range
      const dashRange = action.range || weapon.range;
      const dashDist = distCoords(player.x, player.y, currentTarget.x, currentTarget.y);
      if (dashDist > dashRange) {
        moveToAttackRange(currentTarget, dashRange, String(keyNum));
        return;
      }
      
      // Enable auto-attack - combat has started
      autoAttackEnabled = true;
      inCombat = true;
      
      provokeEnemy(currentTarget);
      executeDash(weapon, action);
      actionCooldowns[keyNum] = action.cooldown;
      actionMaxCooldowns[keyNum] = action.cooldown;
      break;

    default:
      // Fallback for unrecognized types - treat as basic attack
      logCombat(`Unknown action type: ${action.type}, using basic attack`);
      autoAttackEnabled = true;
      inCombat = true;
      playerAttack();
      break;
  }
}

// ============================================
// NEW WEAPON ABILITY SYSTEM (slots 1-3)
// No Sense cost - cooldowns only
// ============================================
export function useWeaponAbility(slot) {
  if (isGhostMode) {
    logCombat('You are a spirit... find your corpse to revive.');
    return;
  }
  
  if (playerImmunityActive) {
    logCombat('Recovering... actions disabled during immunity.');
    return;
  }
  
  // Check GCD
  if (isGcdActive()) {
    const remaining = (getGcdRemaining() / 1000).toFixed(1);
    logCombat(`GCD active (${remaining}s)`);
    return;
  }
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) {
    logCombat('No weapon equipped');
    return;
  }
  
  const ability = weapon.abilities?.[slot];
  if (!ability) {
    logCombat(`Ability ${slot} not available for ${weapon.name}`);
    return;
  }
  
  // Check ability cooldown
  if (actionCooldowns[slot] > 0) {
    const remaining = (actionCooldowns[slot] / 1000).toFixed(1);
    logCombat(`${ability.name} on cooldown (${remaining}s)`);
    return;
  }
  
  // Get ability range and LOS requirements
  const abilityRange = ability.range || weapon.range;
  const needsLOS = weapon.combatType === 'ranged';
  
  // If no target, auto-acquire nearest enemy within ability range
  if (!currentTarget || currentTarget.hp <= 0) {
    const candidate = acquireClosestEnemyInRange({
      maxRange: abilityRange,
      requireLOS: needsLOS
    });
    
    if (candidate) {
      selectTarget(candidate);
      logCombat(`Targeting ${candidate.name}`);
    } else {
      logCombat('No enemies in range.');
      return;
    }
  }
  
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, currentTarget.x, currentTarget.y);
  const hasLOS = !needsLOS || hasLineOfSight(currentState, player.x, player.y, currentTarget.x, currentTarget.y);
  
  // If out of range or no LOS, set intent and let intent system handle move-then-cast
  if (dist > abilityRange || !hasLOS) {
    // Enable combat flags immediately (we're engaging)
    autoAttackEnabled = true;
    inCombat = true;
    
    // Set weapon ability intent - will handle move-then-cast
    const result = setWeaponAbilityIntent(slot, currentTarget);
    if (!result.success) {
      // Target is invalid - provide feedback
      if (result.reason === 'retreating') {
        logCombat('Target is retreating.');
      } else if (result.reason === 'dead') {
        logCombat('Target is dead.');
      } else {
        logCombat('Invalid target.');
      }
      clearTarget();
      return;
    }
    tryExecuteCombatIntent(); // Try immediately, will move if needed
    return;
  }
  
  // In range and LOS - check target validity before executing
  const check = isInvalidCombatTarget(currentTarget);
  if (check.invalid) {
    if (check.reason === 'retreating') {
      logCombat('Target is retreating.');
    } else if (check.reason === 'dead') {
      logCombat('Target is dead.');
    } else {
      logCombat('Invalid target.');
    }
    clearTarget();
    return;
  }
  
  // Execute immediately
  autoAttackEnabled = true;
  inCombat = true;
  provokeEnemy(currentTarget);
  
  // Execute the ability directly
  executeWeaponAbilityDirect(slot);
}

// ============================================
// BURST TIMER MANAGEMENT
// ============================================

/**
 * Clear all active burst timers, optionally filtered by target ID.
 * Called on target death, disengage, or combat cancellation.
 */
function clearBurstTimers(targetId = null) {
  if (targetId === null) {
    // Clear all burst timers
    for (const timer of activeBurstTimers) {
      clearTimeout(timer.timeoutId);
    }
    activeBurstTimers = [];
  } else {
    // Clear only timers for specific target
    activeBurstTimers = activeBurstTimers.filter(timer => {
      if (timer.targetId === targetId) {
        clearTimeout(timer.timeoutId);
        return false;
      }
      return true;
    });
  }
}

// ============================================
// RIFLE ABILITY IMPLEMENTATIONS
// ============================================
function executeRifleBurst(weapon, ability) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const target = currentTarget;
  const targetId = target.id;
  const shots = ability.shots || 3;
  const damagePerShot = ability.damagePerShot || 6;
  
  // Clear any existing burst timers for this target (prevent stacking)
  clearBurstTimers(targetId);
  
  // Fire rapid shots with cancellable timers
  for (let i = 0; i < shots; i++) {
    const timeoutId = setTimeout(() => {
      // Remove this timer from tracking (it's executing now)
      activeBurstTimers = activeBurstTimers.filter(t => t.timeoutId !== timeoutId);
      
      // Guard: stop if target is dead, invalid, or player swapped targets
      if (!target || target.hp <= 0 || target._deathHandled) return;
      if (!currentTarget || currentTarget.id !== targetId) return; // Target swap guard
      
      const damage = calculateDamage(weapon, target, damagePerShot);
      showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().projectilePlayer);
      
      target.hp -= damage;
      markCombatEvent();
      showDamageNumber(target.x, target.y, damage, false);
      
      updateEnemyHealthBar(target);
      updateTargetFrame();
      
      // Check for death and handle (idempotency guard in handleEnemyDeath prevents double-call)
      if (target.hp <= 0) {
        handleEnemyDeath(target);
      }
    }, i * 150); // 150ms between shots
    
    // Track this timer for potential cancellation
    activeBurstTimers.push({ timeoutId, targetId });
  }
  
  logCombat(`Burst: ${shots} shots fired!`);
}

function executeRifleSuppress(weapon, ability) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const damage = calculateDamage(weapon, currentTarget, ability.damage || 10);
  
  showProjectile(player.x, player.y, currentTarget.x, currentTarget.y, getColors().projectileSpecial, true);
  
  currentTarget.hp -= damage;
  markCombatEvent();
  showDamageNumber(currentTarget.x, currentTarget.y, damage, false);
  
  // Apply slow effect
  if (ability.onHit) {
    for (const effect of ability.onHit) {
      applyEffect(currentTarget, effect);
    }
  }
  
  logCombat(`Suppress: ${damage} damage + slow!`);
  
  updateEnemyHealthBar(currentTarget);
  updateTargetFrame();
  
  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
}

function executeRifleOvercharge(weapon, ability) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const damage = calculateDamage(weapon, currentTarget, ability.damage || 30);
  
  // Big enhanced projectile
  showProjectile(player.x, player.y, currentTarget.x, currentTarget.y, getColors().projectileEnemy, true);
  
  currentTarget.hp -= damage;
  markCombatEvent();
  showDamageNumber(currentTarget.x, currentTarget.y, damage, true); // Show as crit for impact
  
  logCombat(`Overcharge: ${damage} heavy damage!`);
  
  updateEnemyHealthBar(currentTarget);
  updateTargetFrame();
  
  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
}

// ============================================
// SWORD ABILITY IMPLEMENTATIONS
// ============================================
function executeSwordCleave(weapon, ability) {
  const player = currentState.player;
  const aoe = ability.aoe || { radius: 1.5, maxTargets: 3 };
  const damage = ability.damage || 12;
  
  // Find enemies in AoE
  const enemies = currentState.runtime.activeEnemies || [];
  const targets = [];
  
  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    const dist = distCoords(player.x, player.y, enemy.x, enemy.y);
    if (dist <= aoe.radius) {
      targets.push(enemy);
      if (targets.length >= aoe.maxTargets) break;
    }
  }
  
  if (targets.length === 0) {
    logCombat('No enemies in range');
    return;
  }
  
  // Show cleave effect
  showCleaveEffect(player.x, player.y);
  
  // Damage all targets
  let totalDamage = 0;
  for (const target of targets) {
    const dmg = calculateDamage(weapon, target, damage);
    target.hp -= dmg;
    totalDamage += dmg;
    markCombatEvent();
    showDamageNumber(target.x, target.y, dmg, false);
    provokeEnemy(target);
    updateEnemyHealthBar(target);
    
    if (target.hp <= 0) {
      handleEnemyDeath(target);
    }
  }
  
  logCombat(`Cleave: ${totalDamage} damage to ${targets.length} enemies!`);
  updateTargetFrame();
}

function executeSwordLunge(weapon, ability) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const dashTiles = ability.dashTiles || 2;
  
  // Calculate position to dash to (adjacent to target)
  const dx = currentTarget.x - player.x;
  const dy = currentTarget.y - player.y;
  const dist = Math.hypot(dx, dy);
  
  if (dist > 0) {
    // Move toward target
    const nx = dx / dist;
    const ny = dy / dist;
    const moveX = Math.round(player.x + nx * Math.min(dashTiles, dist - 1));
    const moveY = Math.round(player.y + ny * Math.min(dashTiles, dist - 1));
    
    // Check if we can move there
    if (canMoveTo(currentState, moveX, moveY)) {
      player.x = moveX;
      player.y = moveY;
      
      // Update player position visually
      const playerEl = document.getElementById('player');
      if (playerEl) {
        playerEl.style.transform = actorTransform(player.x, player.y);
      }
    }
  }
  
  // Perform the strike
  const damage = calculateDamage(weapon, currentTarget, ability.damage || 16);
  
  showMeleeSwipe(player.x, player.y, currentTarget.x, currentTarget.y, getColors().meleePlayer, true);
  
  currentTarget.hp -= damage;
  markCombatEvent();
  showDamageNumber(currentTarget.x, currentTarget.y, damage, true);
  
  logCombat(`Lunge: ${damage} damage!`);
  
  updateEnemyHealthBar(currentTarget);
  updateTargetFrame();
  
  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
}

function executeSwordShockwave(weapon, ability) {
  const player = currentState.player;
  const aoe = ability.aoe || { radius: 2, maxTargets: 5 };
  const damage = ability.damage || 20;
  const knockback = ability.knockbackTiles || 1;
  
  // Find enemies in AoE
  const enemies = currentState.runtime.activeEnemies || [];
  const targets = [];
  
  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    const dist = distCoords(player.x, player.y, enemy.x, enemy.y);
    if (dist <= aoe.radius) {
      targets.push(enemy);
      if (targets.length >= aoe.maxTargets) break;
    }
  }
  
  if (targets.length === 0) {
    logCombat('No enemies in range');
    return;
  }
  
  // Show shockwave effect (use cleave visual for now)
  showCleaveEffect(player.x, player.y);
  
  // Damage and knockback all targets
  let totalDamage = 0;
  for (const target of targets) {
    const dmg = calculateDamage(weapon, target, damage);
    target.hp -= dmg;
    totalDamage += dmg;
    markCombatEvent();
    showDamageNumber(target.x, target.y, dmg, false);
    provokeEnemy(target);
    
    // Knockback
    if (knockback > 0 && target.hp > 0) {
      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        const newX = Math.round(target.x + nx * knockback);
        const newY = Math.round(target.y + ny * knockback);
        
        if (canMoveTo(currentState, newX, newY)) {
          target.x = newX;
          target.y = newY;
          
          // Update enemy position visually
          const enemyEl = document.getElementById(target.id);
          if (enemyEl) {
            enemyEl.style.transform = actorTransform(target.x, target.y);
          }
        }
      }
    }
    
    updateEnemyHealthBar(target);
    
    if (target.hp <= 0) {
      handleEnemyDeath(target);
    }
  }
  
  logCombat(`Shockwave: ${totalDamage} damage to ${targets.length} enemies + knockback!`);
  updateTargetFrame();
}

// ============================================
// SENSE ABILITIES (slots 4-6) - Spends Sense resource
// ============================================
const SENSE_ABILITIES = {
  4: {
    id: 'pull',
    name: 'Pull',
    senseCost: 10,       // 50% of base maxSense (20) - allows chaining
    cooldownMs: 8000,
    radius: 8,           // Affects enemies within 8 tiles
    pullToDistance: 2,   // Pull them to within 2 tiles
    freezeDurationMs: 4000, // 4 second freeze (stun)
    switchToMelee: true,    // Switch to melee weapon on use
    autoAttackClosest: true // Auto-attack closest after pull
  },
  5: {
    id: 'push',
    name: 'Push',
    senseCost: 10,       // 50% of base maxSense (20) - allows chaining
    cooldownMs: 8000,
    radius: 8,           // Affects enemies within 8 tiles
    // Push distance varies by starting distance:
    // 1 tile away = pushed 8 tiles, 8 tiles away = pushed 1 tile
    burnDurationMs: 4000, // 4 second burn
    burnDamagePercent: 10, // 10% of max HP over duration
    switchToRanged: true   // Switch to ranged weapon on use
  },
  6: {
    id: 'locked',
    name: 'Locked',
    locked: true
  }
};

const SENSE_COOLDOWNS = {
  4: { current: 0, max: 8000 },
  5: { current: 0, max: 8000 },
  6: { current: 0, max: 0 }
};

export function useSenseAbility(slot) {
  if (isGhostMode) {
    logCombat('You are a spirit... find your corpse to revive.');
    return;
  }
  
  if (playerImmunityActive) {
    logCombat('Cannot use abilities during immunity');
    return;
  }
  
  // Check GCD
  if (isGcdActive()) {
    const remaining = (getGcdRemaining() / 1000).toFixed(1);
    logCombat(`GCD active (${remaining}s)`);
    return;
  }
  
  const ability = SENSE_ABILITIES[slot];
  if (!ability) {
    logCombat('Invalid sense ability');
    return;
  }
  
  if (ability.locked) {
    logCombat('This ability is locked until Act 3');
    return;
  }
  
  // Check ability cooldown
  if (SENSE_COOLDOWNS[slot].current > 0) {
    const remaining = (SENSE_COOLDOWNS[slot].current / 1000).toFixed(1);
    logCombat(`${ability.name} on cooldown (${remaining}s)`);
    return;
  }
  
  // Check Sense resource
  const player = currentState.player;
  if (player.sense < ability.senseCost) {
    logCombat(`Not enough Sense (need ${ability.senseCost})`);
    return;
  }
  
  // === Sense abilities are AoE centered on player - no target required ===
  // Always fire when pressed (spend Sense, start cooldown, show effect).
  // If no enemies in range, just log it - ability still activates.
  
  // Remember if auto-attack was enabled (to resume after ability)
  const wasAutoAttackEnabled = autoAttackEnabled;
  const previousTarget = currentTarget;
  
  // Execute ability (handles its own enemy detection)
  switch (ability.id) {
    case 'push':
      executePush(ability);
      break;
    case 'pull':
      executePull(ability);
      break;
    default:
      logCombat('Unknown sense ability');
      return;
  }
  
  // Spend Sense (always, regardless of enemies hit)
  player.sense = Math.max(0, player.sense - ability.senseCost);
  updatePlayerSenseBar();
  
  // Set cooldown (always, regardless of enemies hit)
  // Set ability cooldown
  SENSE_COOLDOWNS[slot].current = ability.cooldownMs;
  SENSE_COOLDOWNS[slot].max = ability.cooldownMs;
  updateSenseCooldownUI(slot);
  
  // Trigger GCD
  triggerGcd();
  
  // Resume auto-attack if it was enabled and we have a valid target
  if (wasAutoAttackEnabled && previousTarget && previousTarget.hp > 0) {
    // Refresh the auto-attack intent
    setAutoAttackIntent(previousTarget);
  }
}

/**
 * Push: Pushes enemies within radius to be at least pushToDistance tiles away
 * Collision-safe displacement. Always shows visual effect.
 */
function executePush(ability) {
  const player = currentState.player;
  const enemies = currentState.runtime.activeEnemies || [];
  const affected = [];
  
  // Switch to ranged weapon if not already
  if (ability.switchToRanged && currentWeapon !== 'laser_rifle') {
    setWeapon('laser_rifle');
    logCombat('Switched to ranged weapon.');
  }
  
  // Find enemies within push radius, storing their starting distance
  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    const dist = distCoords(player.x, player.y, enemy.x, enemy.y);
    if (dist <= ability.radius) {
      affected.push({ enemy, startDist: Math.round(dist) });
    }
  }
  
  // Always show visual effect
  showPushEffect(player.x, player.y);
  
  if (affected.length === 0) {
    logCombat('Push: No enemies in range.');
    return;
  }
  
  // Push each enemy away with variable distance based on starting distance
  // Closer enemies get pushed further: dist 1 = push 8, dist 8 = push 1
  // Track occupied tiles to prevent enemies from stacking
  let pushedCount = 0;
  let blockedCount = 0;
  const pushedEnemies = [];
  const occupiedTiles = new Set();
  
  // Pre-populate with player position
  occupiedTiles.add(`${player.x},${player.y}`);
  
  for (const { enemy, startDist } of affected) {
    // Calculate push distance: 9 - starting distance (so dist 1 = push 8, dist 8 = push 1)
    const pushDistance = Math.max(1, 9 - startDist);
    const targetDistance = startDist + pushDistance;
    
    const wasMoved = pushEnemyAway(enemy, player, targetDistance, occupiedTiles);
    
    // Mark the enemy's new position as occupied
    occupiedTiles.add(`${enemy.x},${enemy.y}`);
    
    // Provoke passive enemies (makes them aggro)
    provokeEnemy(enemy, nowMs(), 'push');
    
    // Apply burn effect (10% damage over 4s)
    if (ability.burnDurationMs && ability.burnDamagePercent) {
      applyEffect(enemy, {
        type: 'burn',
        durationMs: ability.burnDurationMs,
        damagePercent: ability.burnDamagePercent
      });
    }
    
    // Flash enemy outline to show they were affected
    flashEnemyAffected(enemy);
    
    if (wasMoved) {
      pushedCount++;
      pushedEnemies.push(enemy);
    } else {
      blockedCount++;
    }
  }
  
  if (pushedCount > 0) {
    logCombat(`Push: ${pushedCount} enemies pushed & burning!`);
    
    // Auto-target the closest pushed enemy and enable auto-attack
    if (pushedEnemies.length > 0) {
      pushedEnemies.sort((a, b) => {
        const distA = distCoords(a.x, a.y, player.x, player.y);
        const distB = distCoords(b.x, b.y, player.x, player.y);
        return distA - distB;
      });
      
      const closestEnemy = pushedEnemies[0];
      selectTarget(closestEnemy);
      autoAttackEnabled = true;
      inCombat = true;
      setAutoAttackIntent(closestEnemy);
    }
  } else if (blockedCount > 0) {
    logCombat(`Push: ${affected.length} enemies burning but blocked by terrain.`);
  }
}


/**
 * Pull: Pulls enemies within radius to within pullToDistance tiles
 * Collision-safe displacement. Always shows visual effect.
 * Freezes enemies (stun) and auto-attacks closest.
 */
function executePull(ability) {
  const player = currentState.player;
  const enemies = currentState.runtime.activeEnemies || [];
  const affected = [];
  
  // Switch to melee weapon if not already
  if (ability.switchToMelee && currentWeapon !== 'vibro_sword') {
    setWeapon('vibro_sword');
    logCombat('Switched to melee weapon.');
  }
  
  // Find enemies within pull radius (but not already close)
  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;
    const dist = distCoords(player.x, player.y, enemy.x, enemy.y);
    if (dist <= ability.radius && dist > ability.pullToDistance) {
      affected.push(enemy);
    }
  }
  
  // Always show visual effect
  showPullEffect(player.x, player.y);
  
  if (affected.length === 0) {
    logCombat('Pull: No enemies in range.');
    return;
  }
  
  // Pull each enemy toward player
  // Track occupied tiles to prevent enemies from stacking
  let pulledCount = 0;
  const pulledEnemies = [];
  const occupiedTiles = new Set();
  
  // Pre-populate with player position
  occupiedTiles.add(`${player.x},${player.y}`);
  
  for (const enemy of affected) {
    const wasMoved = pullEnemyToward(enemy, player, ability.pullToDistance, occupiedTiles);
    
    // Mark the enemy's new position as occupied
    occupiedTiles.add(`${enemy.x},${enemy.y}`);
    
    // Provoke passive enemies (makes them aggro)
    provokeEnemy(enemy, nowMs(), 'pull');
    
    // Apply freeze (stun) effect - can't move or attack for 4s
    if (ability.freezeDurationMs) {
      applyEffect(enemy, {
        type: 'stun',
        durationMs: ability.freezeDurationMs
      });
    }
    
    // Flash enemy outline to show they were affected
    flashEnemyAffected(enemy);
    
    if (wasMoved) {
      pulledCount++;
    }
    pulledEnemies.push(enemy);
  }
  
  logCombat(`Pull: ${pulledCount} enemies pulled & frozen!`);
  
  // Auto-attack closest enemy after pull
  if (ability.autoAttackClosest && pulledEnemies.length > 0) {
    pulledEnemies.sort((a, b) => {
      const distA = distCoords(a.x, a.y, player.x, player.y);
      const distB = distCoords(b.x, b.y, player.x, player.y);
      return distA - distB;
    });
    
    const closestEnemy = pulledEnemies[0];
    selectTarget(closestEnemy);
    autoAttackEnabled = true;
    inCombat = true;
    const result = setAutoAttackIntent(closestEnemy);
    if (result.success) {
      // Immediately try to execute the attack
      tryExecuteCombatIntent();
    }
  }
}


/**
 * Push enemy away from player until at least targetDist away.
 * Step-wise collision check. Returns true if enemy was moved.
 * @param {Set} occupiedTiles - Set of "x,y" strings for tiles already occupied by displaced enemies
 */
function pushEnemyAway(enemy, player, targetDist, occupiedTiles = new Set()) {
  const startX = enemy.x;
  const startY = enemy.y;
  const dx = startX - player.x;
  const dy = startY - player.y;
  const currentDist = Math.hypot(dx, dy);
  
  if (currentDist >= targetDist || currentDist === 0) return false;
  
  // Normalize direction (away from player)
  const nx = dx / currentDist;
  const ny = dy / currentDist;
  
  // Find the furthest valid position step by step
  // We need a continuous path, so track last valid position
  let lastValidX = startX;
  let lastValidY = startY;
  let lastTestedX = startX;
  let lastTestedY = startY;
  const maxSteps = Math.ceil(targetDist - currentDist) + 2;
  
  for (let i = 1; i <= maxSteps; i++) {
    const testX = Math.round(startX + nx * i);
    const testY = Math.round(startY + ny * i);
    
    // Skip duplicate positions (can happen with rounding)
    if (testX === lastTestedX && testY === lastTestedY) continue;
    lastTestedX = testX;
    lastTestedY = testY;
    
    // Check if tile is already occupied by another displaced enemy
    const tileKey = `${testX},${testY}`;
    if (occupiedTiles.has(tileKey)) {
      break; // Can't move here, stop at last valid position
    }
    
    if (canMoveToIgnoreEnemies(currentState, testX, testY)) {
      lastValidX = testX;
      lastValidY = testY;
      
      // Check if we've reached target distance
      const newDist = distCoords(player.x, player.y, lastValidX, lastValidY);
      if (newDist >= targetDist) break;
    } else {
      // Hit an obstacle - stop here, we can't path through walls
      break;
    }
  }
  
  // Only move if we found a new position different from start
  if (lastValidX !== startX || lastValidY !== startY) {
    updateEnemyPosition(enemy, lastValidX, lastValidY, true); // forceMove=true bypasses root check
    return true;
  }
  return false;
}

/**
 * Pull enemy toward player until within targetDist.
 * Step-wise collision check. Returns true if enemy was moved.
 * @param {Set} occupiedTiles - Set of "x,y" strings for tiles already occupied by displaced enemies
 */
function pullEnemyToward(enemy, player, targetDist, occupiedTiles = new Set()) {
  const dx = player.x - enemy.x;
  const dy = player.y - enemy.y;
  const currentDist = Math.hypot(dx, dy);
  
  if (currentDist <= targetDist) return false;
  
  // Normalize direction (toward player)
  const nx = dx / currentDist;
  const ny = dy / currentDist;
  
  // Find the closest valid position step by step
  let newX = enemy.x;
  let newY = enemy.y;
  const maxSteps = Math.ceil(currentDist - targetDist) + 2;
  
  for (let i = 1; i <= maxSteps; i++) {
    const testX = Math.round(enemy.x + nx * i);
    const testY = Math.round(enemy.y + ny * i);
    
    // Don't pull onto the player's tile
    if (testX === player.x && testY === player.y) break;
    
    // Check if tile is already occupied by another displaced enemy
    const tileKey = `${testX},${testY}`;
    if (occupiedTiles.has(tileKey)) {
      break; // Can't move here, stop at last valid position
    }
    
    if (canMoveToIgnoreEnemies(currentState, testX, testY)) {
      newX = testX;
      newY = testY;
      
      // Check if we've reached target distance
      const newDist = distCoords(player.x, player.y, newX, newY);
      if (newDist <= targetDist) break;
    } else {
      break; // Blocked
    }
  }
  
  // Only move if we found a new position
  if (newX !== enemy.x || newY !== enemy.y) {
    updateEnemyPosition(enemy, newX, newY, true); // forceMove=true bypasses root check
    return true;
  }
  return false;
}

/**
 * Show push visual effect (expanding ring)
 * Uses scale3d for GPU-accelerated animation
 */
function showPushEffect(x, y) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;
  
  const size = 6 * 24 * 2; // Final size
  const posX = x * 24 + 12;
  const posY = y * 24 + 12;
  
  const effect = document.createElement('div');
  effect.className = 'push-effect';
  effect.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    width: ${size}px;
    height: ${size}px;
    --pos-x: ${posX}px;
    --pos-y: ${posY}px;
    border: 3px solid var(--sense-color);
    border-radius: 50%;
    pointer-events: none;
    z-index: 150;
    animation: push-expand-gpu 0.4s ease-out forwards;
    transform: translate3d(calc(var(--pos-x) - 50%), calc(var(--pos-y) - 50%), 0) scale3d(0, 0, 1);
    will-change: transform, opacity;
  `;
  
  cachedWorld.appendChild(effect);
  effect.addEventListener('animationend', () => effect.remove(), { once: true });
  
  // Show floating "PUSH!" text
  showSenseAbilityText(x, y, 'PUSH!', getColors().abilityPush);
}

/**
 * Show pull visual effect (contracting ring)
 * Uses scale3d for GPU-accelerated animation
 */
function showPullEffect(x, y) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;
  
  const size = 6 * 24 * 2; // Starting size
  const posX = x * 24 + 12;
  const posY = y * 24 + 12;
  
  const effect = document.createElement('div');
  effect.className = 'pull-effect';
  effect.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    width: ${size}px;
    height: ${size}px;
    --pos-x: ${posX}px;
    --pos-y: ${posY}px;
    border: 3px solid var(--sense-color);
    border-radius: 50%;
    pointer-events: none;
    z-index: 150;
    animation: pull-contract-gpu 0.4s ease-in forwards;
    transform: translate3d(calc(var(--pos-x) - 50%), calc(var(--pos-y) - 50%), 0) scale3d(1, 1, 1);
    will-change: transform, opacity;
  `;
  
  cachedWorld.appendChild(effect);
  effect.addEventListener('animationend', () => effect.remove(), { once: true });
  
  // Show floating "PULL!" text
  showSenseAbilityText(x, y, 'PULL!', getColors().abilityPull);
}

/**
 * Show floating ability text (PUSH!/PULL!) above player
 */
function showSenseAbilityText(x, y, text, color) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;
  
  const posX = x * 24 + 12;
  const posY = y * 24 - 8;
  
  const textEl = document.createElement('div');
  textEl.className = 'sense-ability-text';
  textEl.textContent = text;
  textEl.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    --pos-x: ${posX}px;
    --pos-y: ${posY}px;
    color: ${color};
    font-family: var(--font-display, 'Rajdhani', sans-serif);
    font-size: 1rem;
    font-weight: bold;
    text-shadow: 0 0 8px ${color}, 0 0 12px ${color}, 2px 2px 2px rgba(0, 0, 0, 0.9);
    pointer-events: none;
    z-index: 200;
    transform: translate3d(calc(var(--pos-x) - 50%), var(--pos-y), 0);
    animation: sense-text-float 0.8s ease-out forwards;
    will-change: transform, opacity;
  `;
  
  cachedWorld.appendChild(textEl);
  textEl.addEventListener('animationend', () => textEl.remove(), { once: true });
}

/**
 * Flash enemy outline when affected by Push/Pull
 * Uses simple CSS transition (not animation) to avoid conflicts with position transition.
 */
function flashEnemyAffected(enemy) {
  const enemyEl = getEnemyEl(enemy.id);
  if (!enemyEl) return;
  
  // Add the flash class (CSS handles the visual with transition)
  enemyEl.classList.add('sense-affected');
  
  // Remove after flash duration (400ms matches the transition)
  setTimeout(() => {
    enemyEl.classList.remove('sense-affected');
  }, 400);
}

/**
 * Update sense ability cooldown UI
 */
function updateSenseCooldownUI(slot) {
  const slotEl = document.querySelector(`[data-slot="${slot}"][data-action-type="sense"]`);
  if (!slotEl) return;
  
  const cooldown = SENSE_COOLDOWNS[slot];
  if (!cooldown) return;
  
  const overlay = slotEl.querySelector('.cooldown-overlay');
  const timer = slotEl.querySelector('.cooldown-timer');
  
  if (cooldown.current > 0) {
    slotEl.classList.add('on-cooldown');
    if (overlay) {
      overlay.style.setProperty('--cooldown-pct', (cooldown.current / cooldown.max) * 100);
    }
    if (timer) {
      timer.textContent = Math.ceil(cooldown.current / 1000);
    }
  } else {
    slotEl.classList.remove('on-cooldown');
    if (overlay) {
      overlay.style.setProperty('--cooldown-pct', 0);
    }
    if (timer) {
      timer.textContent = '';
    }
  }
}

/**
 * Tick sense cooldowns - called from combat tick
 */
function tickSenseCooldowns(deltaMs) {
  for (const slot of Object.keys(SENSE_COOLDOWNS)) {
    const cooldown = SENSE_COOLDOWNS[slot];
    if (cooldown.current > 0) {
      cooldown.current = Math.max(0, cooldown.current - deltaMs);
      updateSenseCooldownUI(parseInt(slot, 10));
    }
  }
}

// ============================================
// UTILITY ABILITIES (Sprint, Heal)
// ============================================
const UTILITY_COOLDOWNS = {
  sprint: { current: 0, max: 30000 },  // 30s cooldown
  heal: { current: 0, max: 120000 }     // 120s cooldown
};

/**
 * Use a utility ability (Sprint/Heal).
 * 
 * CRITICAL: Utilities MUST NEVER:
 * - Set autoAttackEnabled
 * - Set inCombat
 * - Create combatIntent
 * - Call provokeEnemy()
 * - Auto-target enemies
 * 
 * Utilities can be used during combat but don't start or modify combat state.
 */
export function useUtilityAbility(id) {
  // DEV-ONLY: Capture state before execution for assertion
  const beforeAutoAttack = autoAttackEnabled;
  const beforeIntent = combatIntent;
  
  switch (id) {
    case 'sprint':
      executeSprint();
      break;
    case 'heal':
      executeHeal();
      break;
    default:
      logCombat(`Unknown utility: ${id}`);
      return;
  }
  
  // DEV-ONLY: Assert utilities didn't modify combat state
  if (autoAttackEnabled !== beforeAutoAttack) {
    console.warn(`[VETUU BUG] Utility '${id}' modified autoAttackEnabled! This violates utility rules.`);
  }
  if (combatIntent !== beforeIntent && combatIntent !== null) {
    console.warn(`[VETUU BUG] Utility '${id}' created a combatIntent! This violates utility rules.`);
  }
}

/**
 * Sprint: 70% movement speed increase for 8 seconds
 * CD: 30s (starts AFTER buff ends)
 */
function executeSprint() {
  if (playerImmunityActive) {
    logCombat('Cannot sprint during immunity');
    return;
  }
  
  // Check cooldown
  if (UTILITY_COOLDOWNS.sprint.current > 0) {
    const remaining = (UTILITY_COOLDOWNS.sprint.current / 1000).toFixed(1);
    logCombat(`Sprint on cooldown (${remaining}s)`);
    return;
  }
  
  // Activate sprint buff (handled in movement.js)
  // Pass callback to start cooldown when buff ends
  import('./movement.js').then(({ activateSprintBuff }) => {
    activateSprintBuff(() => {
      // Buff ended - NOW start cooldown
      UTILITY_COOLDOWNS.sprint.current = UTILITY_COOLDOWNS.sprint.max;
      updateUtilityCooldownUI('sprint');
    });
  });
  
  logCombat('Sprint! +70% movement speed for 8s');
}

/**
 * Heal: Restore 75% max HP
 * CD: 120s, disabled in ghost mode
 */
function executeHeal() {
  if (isGhostMode) {
    logCombat('You are a spirit... find your corpse to revive.');
    return;
  }
  
  if (playerImmunityActive) {
    logCombat('Cannot heal during immunity');
    return;
  }
  
  // Check cooldown
  if (UTILITY_COOLDOWNS.heal.current > 0) {
    const remaining = (UTILITY_COOLDOWNS.heal.current / 1000).toFixed(1);
    logCombat(`Heal on cooldown (${remaining}s)`);
    return;
  }
  
  const player = currentState.player;
  const maxHp = getMaxHP(player);
  const healAmount = Math.floor(maxHp * 0.75);
  const actualHeal = Math.min(healAmount, maxHp - player.hp);
  
  if (actualHeal <= 0) {
    logCombat('Already at full health');
    return;
  }
  
  // Apply heal
  player.hp = Math.min(maxHp, player.hp + healAmount);
  
  // Visual feedback - healing glow animation
  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.classList.add('healing');
    playerEl.addEventListener('animationend', function handler() {
      playerEl.classList.remove('healing');
      playerEl.removeEventListener('animationend', handler);
    });
  }
  
  // Show heal number
  showHealNumber(player.x, player.y, actualHeal);
  
  // Update UI (updatePlayerHealthBar handles frame, HUD, and sprite)
  updatePlayerHealthBar();
  
  // Set cooldown
  UTILITY_COOLDOWNS.heal.current = UTILITY_COOLDOWNS.heal.max;
  updateUtilityCooldownUI('heal');
  
  logCombat(`Healed for ${actualHeal} HP!`);
}

/**
 * Show heal number floating up from position
 */
function showHealNumber(x, y, amount) {
  const world = document.getElementById('world');
  if (!world) return;
  
  const heal = document.createElement('div');
  heal.className = 'damage-number heal-number';
  heal.textContent = `+${amount}`;
  heal.style.setProperty('--pos-x', `${x * 24 + 12}px`);
  heal.style.setProperty('--pos-y', `${y * 24}px`);
  
  world.appendChild(heal);
  heal.addEventListener('animationend', () => heal.remove(), { once: true });
}

/**
 * Update utility cooldown UI display
 */
function updateUtilityCooldownUI(utilityId) {
  const slot = document.querySelector(`[data-slot="${utilityId}"]`);
  if (!slot) return;
  
  const cooldown = UTILITY_COOLDOWNS[utilityId];
  if (!cooldown) return;
  
  const overlay = slot.querySelector('.cooldown-overlay');
  const timer = slot.querySelector('.cooldown-timer');
  
  if (cooldown.current > 0) {
    slot.classList.add('on-cooldown');
    if (overlay) {
      overlay.style.setProperty('--cooldown-pct', (cooldown.current / cooldown.max) * 100);
    }
    if (timer) {
      timer.textContent = Math.ceil(cooldown.current / 1000);
    }
  } else {
    slot.classList.remove('on-cooldown');
    if (overlay) {
      overlay.style.setProperty('--cooldown-pct', 0);
    }
    if (timer) {
      timer.textContent = '';
    }
  }
}

/**
 * Tick utility cooldowns - called from game loop
 */
export function tickUtilityCooldowns(deltaMs) {
  for (const [id, cooldown] of Object.entries(UTILITY_COOLDOWNS)) {
    if (cooldown.current > 0) {
      cooldown.current = Math.max(0, cooldown.current - deltaMs);
      updateUtilityCooldownUI(id);
    }
  }
}

function checkRangeAndLOS(weapon, actionType = null) {
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, currentTarget.x, currentTarget.y);

  if (dist > weapon.range) {
    // Move to range if action type provided
    if (actionType !== null) {
      moveToAttackRange(currentTarget, weapon.range, actionType);
    } else {
    logCombat(`Out of range`);
    }
    return false;
  }

  if (!hasLineOfSight(currentState, player.x, player.y, currentTarget.x, currentTarget.y)) {
    logCombat('No line of sight');
    return false;
  }

  return true;
}

function executeEnhancedAttack(weapon, action) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  let damage = calculateDamage(weapon, currentTarget, action.damage);

  if (weapon.type === 'ranged') {
    showProjectile(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || getColors().meleePlayer, true);
  } else {
    showMeleeSwipe(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || getColors().meleeSpecial, true);
  }

  currentTarget.hp -= damage;
  markCombatEvent(); // Track combat activity for regen gating
  showDamageNumber(currentTarget.x, currentTarget.y, damage, true);
  logCombat(`${action.name || 'Enhanced Attack'}: ${damage} damage!`);

  // Apply on-hit effects (slow, stun, root, etc.)
  if (action.onHit && Array.isArray(action.onHit)) {
    for (const effect of action.onHit) {
      applyEffect(currentTarget, effect);
      logCombat(`Applied ${effect.type} for ${effect.durationMs || 0}ms`);
    }
    updateEnemyStatusEffects(currentTarget);
  }

  updateEnemyHealthBar(currentTarget);
  updateTargetFrame();

  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
}

function executeDoubleAttack(weapon, action) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const target = currentTarget; // Capture reference
  
  // First shot
  const damage1 = calculateDamage(weapon, target, action.damage);
  showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().meleePlayer);
  target.hp -= damage1;
  markCombatEvent(); // Track combat activity
  showDamageNumber(target.x, target.y, damage1, false);
  updateEnemyHealthBar(target);
  updateTargetFrame();
  
  if (target.hp <= 0) {
    handleEnemyDeath(target);
    logCombat(`Double Tap! ${damage1} damage!`);
    return;
  }
  
  // Second shot with delay
  const extraDelay = action.extraShot?.delayMs || 150;
  const extraDamage = action.extraShot?.damage || action.damage;
  
    setTimeout(() => {
    if (!target || target.hp <= 0) return;
    
    const damage2 = calculateDamage(weapon, target, extraDamage);
    showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().meleePlayer);
    target.hp -= damage2;
    markCombatEvent(); // Track combat activity
    showDamageNumber(target.x, target.y, damage2, false);
    updateEnemyHealthBar(target);
      updateTargetFrame();

    if (target.hp <= 0) {
      handleEnemyDeath(target);
      }
  }, extraDelay);

  logCombat(`Double Tap!`);
}

function executeRapidFire(weapon, action) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  
  const player = currentState.player;
  const target = currentTarget; // Capture reference
  const shots = action.shots || 3;
  const shotDelay = action.shotDelayMs || 120;
  
  // Sense cost is handled by useAction, but check here as safety
  if (action.senseCost && player.sense >= action.senseCost) {
  player.sense -= action.senseCost;
  updatePlayerSenseBar();
  }

  for (let i = 0; i < shots; i++) {
    setTimeout(() => {
      if (!target || target.hp <= 0) return;

      const damage = calculateDamage(weapon, target, action.damage);
      showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().meleePlayer);
      target.hp -= damage;
      markCombatEvent(); // Track combat activity
      showDamageNumber(target.x, target.y, damage, false);
      updateEnemyHealthBar(target);
      updateTargetFrame();

      // Apply on-hit effects on last shot
      if (i === shots - 1 && action.onHit && Array.isArray(action.onHit)) {
        for (const effect of action.onHit) {
          applyEffect(target, effect);
        }
        updateEnemyStatusEffects(target);
      }

      if (target.hp <= 0) {
        handleEnemyDeath(target);
      }
    }, i * shotDelay);
  }

  logCombat(`${action.name || 'Rapid Fire'}!`);
}

function executeCleave(weapon, action) {
  const player = currentState.player;
  const adjacent = getAdjacentEnemies(player.x, player.y);

  if (adjacent.length === 0) {
    logCombat('No enemies in range');
    return;
  }

  // Sense is now spent in useAction() case handler before calling this
  showCleaveEffect(player.x, player.y);

  for (const enemy of adjacent) {
    provokeEnemy(enemy);
    let damage = calculateDamage(weapon, enemy, action.multiplier || 1);
    enemy.hp -= damage;
    markCombatEvent(); // Track combat activity for regen gating
    showDamageNumber(enemy.x, enemy.y, damage, true);
    updateEnemyHealthBar(enemy);
    
    // Apply onHit effects
    if (action.onHit) {
      action.onHit.forEach(effect => applyEffect(enemy, effect));
    }
    
    if (enemy.hp <= 0) handleEnemyDeath(enemy);
  }

  logCombat(`Cleave: Hit ${adjacent.length} enemies!`);
}

function executeDash(weapon, action) {
  if (!currentTarget || currentTarget.hp <= 0) {
    logCombat('No target');
    return;
  }

  const player = currentState.player;
  const targetX = currentTarget.x;
  const targetY = currentTarget.y;
  
  // Calculate dash position (adjacent to target)
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const dist = Math.hypot(dx, dy);
  
  if (dist > 0) {
    // Normalize and scale to get position adjacent to target
    const dashTiles = action.dashTiles || 2;
    const moveX = Math.round(dx / dist * Math.min(dashTiles, dist - 1));
    const moveY = Math.round(dy / dist * Math.min(dashTiles, dist - 1));
    
    const newX = player.x + moveX;
    const newY = player.y + moveY;
    
    // Check if we can move there
    if (canMoveTo(currentState, newX, newY)) {
      // Teleport player to new position
      player.x = newX;
      player.y = newY;
      
      // Update visual position (instant teleport, no transition)
      const playerEl = document.getElementById('player');
      if (playerEl) {
        playerEl.style.transition = 'none';
        playerEl.style.transform = actorTransform(newX, newY);
        playerEl.offsetHeight; // Force reflow
        playerEl.style.transition = '';
      }
      
      // Update camera (instant snap)
      import('./render.js').then(({ updateCamera }) => {
        if (typeof updateCamera === 'function') updateCamera(currentState, 0);
      });
    }
  }
  
  // Now deal damage
  const damage = calculateDamage(weapon, currentTarget, (action.damage / weapon.baseDamage) || 1);
  
  showMeleeSwipe(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor);
  
  currentTarget.hp -= damage;
  showDamageNumber(currentTarget.x, currentTarget.y, damage, true);
  updateEnemyHealthBar(currentTarget);
  
  // Apply onHit effects (root)
  if (action.onHit) {
    action.onHit.forEach(effect => applyEffect(currentTarget, effect));
  }
  
  logCombat(`Lunge! ${damage} damage`);
  
  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
}

/**
 * Legacy "special attack" function - triggers slot 3 ability.
 * TODO: Migrate callers to use handleTargeting('weaponAbility', 3) instead
 */
export function playerSpecial() {
  useAction('3');
}

/**
 * Calculate damage from player to enemy using unified formula.
 * Includes rifle min-range penalty and type effectiveness.
 * 
 * @param {object} weapon - Current weapon object
 * @param {object} target - Target enemy
 * @param {number} actionDamage - Optional skill-specific damage override
 * @returns {number} Final damage value
 */
function calculateDamage(weapon, target, actionDamage = null) {
  const player = currentState.player;
  const config = ENEMY_CONFIGS[target.type] || {};
  const baseDamage = actionDamage || weapon.baseDamage || 10;
  
  // Calculate skill multiplier with rifle min-range penalty
  let skillMult = weapon.multiplier || 1;
  if (currentWeapon === 'laser_rifle') {
    const d = distCoords(player.x, player.y, target.x, target.y);
    if (d <= 2) {
      skillMult *= 0.65; // -35% damage when rifle is too close
    }
  }
  
  const { damage, isCrit } = computeDamage({
    attacker: player,
    defender: target,
    defenderConfig: config,
    baseDamage,
    skillMult,
    damageType: weapon.damageType || null,
    forceNoCrit: false,
    source: "player",
    attackId: weapon.id || weapon.name || "attack",
    attackerName: "Rex"
  });
  
  // Store crit flag for UI effects
  weapon.__lastCrit = isCrit;
  
  return damage;
}

function getAdjacentEnemies(x, y) {
  const adjacent = [];
  const offsets = [
    { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
    { dx: -1, dy: 0 },                      { dx: 1, dy: 0 },
    { dx: -1, dy: 1 },  { dx: 0, dy: 1 },  { dx: 1, dy: 1 }
  ];

  for (const enemy of currentState.runtime.activeEnemies) {
    if (enemy.hp <= 0) continue;
    for (const off of offsets) {
      if (enemy.x === x + off.dx && enemy.y === y + off.dy) {
        adjacent.push(enemy);
        break;
      }
    }
  }

  return adjacent;
}

// ============================================
// VISUAL EFFECTS
// ============================================
// Object pools for combat effects
const projectilePool = [];
const swipePool = [];
const EFFECT_POOL_SIZE = 10;

function getPooledElement(pool, className) {
  const pooled = pool.pop();
  if (pooled) return pooled;
  
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function recycleElement(pool, el, baseClass) {
  el.className = baseClass;
  if (pool.length < EFFECT_POOL_SIZE) {
    pool.push(el);
  }
}

function showProjectile(fromX, fromY, toX, toY, color, isEnhanced = false) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;

  const projectile = getPooledElement(projectilePool, 'projectile');
  
  // Reset animation by removing class, forcing reflow, then re-adding
  projectile.className = '';
  projectile.style.animation = 'none';
  void projectile.offsetHeight; // Force reflow
  projectile.style.animation = '';
  
  projectile.className = `projectile ${isEnhanced ? 'enhanced' : ''}`;
  projectile.style.setProperty('--color', color);
  projectile.style.setProperty('--pos-x', `${fromX * 24 + 12}px`);
  projectile.style.setProperty('--pos-y', `${fromY * 24 + 12}px`);

  const dx = (toX - fromX) * 24;
  const dy = (toY - fromY) * 24;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  projectile.style.setProperty('--dx', `${dx}px`);
  projectile.style.setProperty('--dy', `${dy}px`);
  projectile.style.setProperty('--angle', `${angle}deg`);

  cachedWorld.appendChild(projectile);
  projectile.addEventListener('animationend', () => {
    projectile.remove();
    recycleElement(projectilePool, projectile, 'projectile');
  }, { once: true });
}

function showMeleeSwipe(fromX, fromY, toX, toY, color, isEnhanced = false) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;

  const swipe = getPooledElement(swipePool, 'melee-swipe');
  
  // Reset animation by removing class, forcing reflow, then re-adding
  swipe.className = '';
  swipe.style.animation = 'none';
  void swipe.offsetHeight; // Force reflow
  swipe.style.animation = '';
  
  swipe.className = `melee-swipe ${isEnhanced ? 'enhanced' : ''}`;
  swipe.style.setProperty('--color', color);
  swipe.style.setProperty('--pos-x', `${toX * 24}px`);
  swipe.style.setProperty('--pos-y', `${toY * 24}px`);

  const dx = toX - fromX;
  const dy = toY - fromY;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  swipe.style.setProperty('--angle', `${angle}deg`);

  cachedWorld.appendChild(swipe);
  swipe.addEventListener('animationend', () => {
    swipe.remove();
    recycleElement(swipePool, swipe, 'melee-swipe');
  }, { once: true });
}

function showCleaveEffect(x, y) {
  const world = document.getElementById('world');
  if (!world) return;

  const cleave = document.createElement('div');
  cleave.className = 'cleave-effect';
  cleave.style.setProperty('--pos-x', `${x * 24 - 24}px`);
  cleave.style.setProperty('--pos-y', `${y * 24 - 24}px`);

  world.appendChild(cleave);
  cleave.addEventListener('animationend', () => cleave.remove(), { once: true });
}

// ============================================
// WEAPON CYCLING (Simplified - only 2 weapons)
// ============================================
export function cycleWeapon() {
  // Toggle between rifle and sword only
  if (currentWeapon === 'laser_rifle') {
    currentWeapon = 'vibro_sword';
  } else {
    currentWeapon = 'laser_rifle';
  }

  const weapon = WEAPONS[currentWeapon];
  
  // Update ability cooldowns from new abilities structure
  if (weapon && weapon.abilities) {
    Object.entries(weapon.abilities).forEach(([slot, ability]) => {
      actionMaxCooldowns[parseInt(slot, 10)] = ability.cooldownMs || 6000;
    });
  }

  logCombat(`Switched to ${weapon?.name || currentWeapon}`);
  updateActionBar();
  updateWeaponToggleSlot();
}

export function setWeapon(weaponKey) {
  // Only allow rifle or sword
  if (weaponKey !== 'laser_rifle' && weaponKey !== 'vibro_sword') {
    console.warn(`[Combat] Invalid weapon key: ${weaponKey}. Using rifle.`);
    weaponKey = 'laser_rifle';
  }
  
  if (WEAPONS[weaponKey]) {
    currentWeapon = weaponKey;
    const weapon = WEAPONS[currentWeapon];
    
    // Update ability cooldowns from new abilities structure
    if (weapon?.abilities) {
      Object.entries(weapon.abilities).forEach(([slot, ability]) => {
        actionMaxCooldowns[parseInt(slot, 10)] = ability.cooldownMs || 6000;
      });
    }
    
    updateActionBar();
    updateWeaponToggleSlot();
  }
}

/**
 * Update the weapon toggle slot UI
 */
function updateWeaponToggleSlot() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;
  
  const iconEl = document.getElementById('weapon-slot-icon');
  const labelEl = document.getElementById('weapon-slot-label');
  
  if (iconEl) iconEl.textContent = weapon.icon || '🔫';
  if (labelEl) labelEl.textContent = weapon.name || 'Weapon';
}

export function getCurrentWeapon() {
  return currentWeapon;
}

export function getWeapons() {
  return WEAPONS;
}

/**
 * Get swing timer state for UI display
 * Returns { progress: 0-1, remainingMs: number, isReady: boolean }
 */
export function getSwingTimerState() {
  const now = nowMs();
  
  // If no basic intent active, timer is ready
  if (!combatIntent || combatIntent.type !== 'basic') {
    return { progress: 1, remainingMs: 0, isReady: true };
  }
  
  const nextAttackAt = combatIntent.nextAttackAt || 0;
  const cooldownStartedAt = combatIntent.cooldownStartedAt || 0;
  
  // Ready to attack (nextAttackAt = 0 means ready immediately)
  if (nextAttackAt <= now) {
    return { progress: 1, remainingMs: 0, isReady: true };
  }
  
  // Calculate progress based on when cooldown started (more accurate)
  const elapsed = now - cooldownStartedAt;
  const progress = Math.min(1, elapsed / BASIC_ATTACK_CD_MS);
  const remainingMs = Math.max(0, nextAttackAt - now);
  
  return {
    progress: Math.max(0, progress),
    remainingMs,
    isReady: false
  };
}

// ============================================
// COMBAT INTENT SYSTEM
// ============================================
// Intent system for: basic attacks, weapon abilities
// Sense abilities (push/pull) execute immediately - no intent needed
// Utility abilities (sprint/heal) NEVER create intents
const INTENT_TIMEOUT_MS = 10000; // 10s - clear intent if no successful attack

/**
 * Combat Intent Schema:
 * {
 *   type: 'basic' | 'weaponAbility',
 *   slot: number (1-3 for abilities, not used for basic),
 *   targetId: string,
 *   createdAt: number,
 *   retryAt: number,
 *   lastSuccessAt: number,
 *   expiresAt: number,
 *   requiresLOS: boolean,
 *   requiredRange: number,
 *   nextAttackAt: number (only for basic - timer-gated auto-attack)
 * }
 */
let combatIntent = null;

/**
 * Check if an enemy is an invalid combat target.
 * Centralizes all "should stop attacking this target" logic.
 * 
 * @param {object} enemy - The enemy to check
 * @param {number} t - Current time (performance.now())
 * @returns {{ invalid: boolean, reason: string|null }}
 */
function isInvalidCombatTarget(enemy, t = nowMs()) {
  // No enemy
  if (!enemy) {
    return { invalid: true, reason: 'no_target' };
  }
  
  // Dead
  if (enemy.hp <= 0 || enemy._deathHandled) {
    return { invalid: true, reason: 'dead' };
  }
  
  // Actively retreating - has disengaged
  if (enemy.isRetreating) {
    return { invalid: true, reason: 'retreating' };
  }
  
  // Broken off AND not currently engaged - has disengaged
  // (If still engaged, they're in combat and valid)
  if (isBrokenOff(enemy, t) && !enemy.isEngaged) {
    return { invalid: true, reason: 'broken_off' };
  }
  
  // Valid target
  return { invalid: false, reason: null };
}

/**
 * Set basic auto-attack intent on a target.
 * Intent persists until target dies, player cancels, or timeout.
 * Uses weapon.basic spec for damage/range/LOS (NOT slot 1 ability).
 * Timer-gated: attacks occur every BASIC_ATTACK_CD_MS (1.5s shared cadence).
 * @returns {{ success: boolean, reason?: string }}
 */
function setAutoAttackIntent(target) {
  // Use centralized validity check
  const check = isInvalidCombatTarget(target);
  if (check.invalid) {
    return { success: false, reason: check.reason };
  }
  
  const weapon = WEAPONS[currentWeapon];
  const basic = weapon?.basic;
  const range = basic?.range || weapon?.range || 1;
  const requiresLOS = basic?.requiresLOS ?? (weapon?.combatType === 'ranged');
  
  // Preserve existing timer state if target hasn't changed (prevents timer reset on spam)
  const now = nowMs();
  const preserveTimer = combatIntent?.type === 'basic' && 
                        combatIntent?.targetId === target.id &&
                        combatIntent?.nextAttackAt > now;
  
  combatIntent = {
    type: 'basic',
    targetId: target.id,
    createdAt: now,
    retryAt: 0,
    lastSuccessAt: 0,
    expiresAt: now + INTENT_TIMEOUT_MS,
    requiresLOS,
    requiredRange: range,
    // Timer: 0 = ready to attack immediately, otherwise wait until this time
    nextAttackAt: preserveTimer ? combatIntent.nextAttackAt : 0,
    // Preserve cooldown start time for accurate UI progress
    cooldownStartedAt: preserveTimer ? combatIntent.cooldownStartedAt : 0
  };
  
  return { success: true };
}

/**
 * Set weapon ability intent (slots 1-3).
 * One-shot: clears after successful execution.
 * @returns {{ success: boolean, reason?: string }}
 */
function setWeaponAbilityIntent(slot, target) {
  // Use centralized validity check
  const check = isInvalidCombatTarget(target);
  if (check.invalid) {
    return { success: false, reason: check.reason };
  }
  
  const weapon = WEAPONS[currentWeapon];
  const ability = weapon?.abilities?.[slot];
  if (!ability) return;
  
  const range = ability.range || weapon.range;
  const requiresLOS = weapon?.combatType === 'ranged';
  
  combatIntent = {
    type: 'weaponAbility',
    slot,
    targetId: target.id,
    createdAt: nowMs(),
    retryAt: 0,
    lastSuccessAt: 0,
    expiresAt: nowMs() + INTENT_TIMEOUT_MS,
    requiresLOS,
    requiredRange: range
  };
  
  return { success: true };
}

// NOTE: Sense abilities (push/pull) don't use the intent system.
// They are AoE and execute immediately via useSenseAbility().

/**
 * Clear combat intent and any associated state.
 */
function clearCombatIntent() {
  combatIntent = null;
  pendingAttack = null; // Also clear pending attack when intent cleared
  // Note: burst timers are cleared separately via clearBurstTimers() when needed
  // (they may belong to a different target than the intent)
}

/**
 * Cancel combat pursuit (move-to-range) but preserve basic auto-attack for kiting.
 * 
 * Behavior:
 * - If pursuing for a WEAPON ABILITY: fully disengage (clear intent + auto-attack)
 *   → Player explicitly chose to cancel the ability, don't start auto-attacking
 * - If in BASIC auto-attack: keep attacking (allows kiting)
 *   → Player is just repositioning while fighting
 */
export function cancelCombatPursuit() {
  // Canceling a weapon ability pursuit = full disengage
  // Player explicitly decided not to use the ability
  if (combatIntent?.type === 'weaponAbility') {
    clearCombatIntent();
    clearBurstTimers(); // Cancel any in-flight burst attacks
    autoAttackEnabled = false; // Don't start auto-attacking after canceling ability
  }
  // Clear any pending movement for attack
  pendingAttack = null;
  // Basic auto-attack continues (kiting behavior preserved)
}

/**
 * Cancel combat engagement completely (Escape key, explicit disengage).
 * Clears all intent, auto-attack, pending attack, and burst timers.
 */
export function cancelCombatEngagement() {
  clearCombatIntent();
  clearBurstTimers(); // Cancel any in-flight burst attacks
  autoAttackEnabled = false;
  // Don't clear inCombat or target - player might still want to re-engage
  // Just stop the automatic pursuit
}

/**
 * Get the target from current intent (resolves by id).
 */
function getIntentTarget() {
  if (!combatIntent?.targetId || !currentState?.runtime?.activeEnemies) return null;
  return currentState.runtime.activeEnemies.find(e => e.id === combatIntent.targetId);
}

/**
 * Try to execute combat intent.
 * Called: after movement completes, in combat tick, on intent creation.
 * 
 * Unified flow:
 * 1. Resolve target from intent.targetId if required
 * 2. If target dead: reacquire or clear intent
 * 3. If range/LOS not satisfied: moveToAttackRange and return
 * 4. If player is moving: return
 * 5. If cooldown/GCD blocks: schedule retryAt and return
 * 6. Execute based on intent type
 * 7. On success: update lastSuccessAt, clear if one-shot ability
 */
export function tryExecuteCombatIntent() {
  if (!combatIntent) return;
  
  // Never process utility intents (should never exist, but safety check)
  if (combatIntent.type === 'utility') {
    clearCombatIntent();
    return;
  }
  
  const now = nowMs();
  
  // Timeout check - clear intent if expired
  if (now > combatIntent.expiresAt) {
    logCombat('Lost target.');
    clearCombatIntent();
    return;
  }
  
  // === GUARDRAIL: Check if target is invalid ===
  // Centralized check for all "should stop attacking" conditions
  const intentTarget = getIntentTarget();
  const targetCheck = isInvalidCombatTarget(intentTarget, now);
  if (targetCheck.invalid && targetCheck.reason !== 'dead') {
    // Dead targets are handled by executeBasicIntent (reacquisition logic)
    // Other invalid states (retreating, broken_off) = stop pursuit
    logCombat('Target disengaged.');
    clearCombatIntent();
    autoAttackEnabled = false;
    inCombat = false;
    return;
  }
  
  // Throttle retries (prevent spam when immune)
  if (combatIntent.retryAt && now < combatIntent.retryAt) return;
  
  // Check if player is currently moving (import check)
  // Movement module will call us again when move completes
  const { isCurrentlyMoving } = window.__vetuuMovement || {};
  if (isCurrentlyMoving?.()) return;
  
  // Handle by intent type
  switch (combatIntent.type) {
    case 'basic':
      executeBasicIntent(now);
      break;
    case 'weaponAbility':
      executeWeaponAbilityIntent(now);
      break;
    // NOTE: senseAbility intents are not used - sense abilities execute immediately
  }
}

/**
 * Execute basic auto-attack intent (timer-gated, 1.5s shared cadence)
 * Uses weapon.basic.damage - NOT slot 1 ability damage
 */
function executeBasicIntent(now) {
  let target = getIntentTarget();
  
  // Target invalid - try to reacquire
  if (!target || target.hp <= 0) {
    const nextTarget = findNextCombatTarget();
    if (nextTarget) {
      combatIntent.targetId = nextTarget.id;
      combatIntent.lastSuccessAt = 0; // Reset timeout
      combatIntent.expiresAt = now + INTENT_TIMEOUT_MS;
      combatIntent.nextAttackAt = 0; // Ready to attack new target immediately
      target = nextTarget;
      selectTarget(target);
    } else {
      clearCombatIntent();
      return;
    }
  }
  
  // Ensure target is selected
  if (currentTarget?.id !== target.id) {
    selectTarget(target);
  }
  
  // Check spawn immunity - schedule retry
  if (hasSpawnImmunity(target)) {
    combatIntent.retryAt = now + 200;
    return;
  }
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;
  
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, target.x, target.y);
  const hasLOS = !combatIntent.requiresLOS || hasLineOfSight(currentState, player.x, player.y, target.x, target.y);
  
  // Out of range or no LOS
  if (dist > combatIntent.requiredRange || !hasLOS) {
    // Initial engagement (never attacked yet): path to enemy
    // This handles right-click on out-of-range enemy
    if (!combatIntent.lastSuccessAt && !pendingAttack) {
      moveToAttackRange(target, combatIntent.requiredRange, 'basic');
    }
    // Already in combat (has attacked): don't auto-chase, allows kiting
    // Player controls movement; attacks resume when back in range
    return;
  }
  
  // Timer gating: check if enough time has passed since last basic attack
  if (combatIntent.nextAttackAt > now) {
    // Not ready yet - schedule retry after remaining time
    combatIntent.retryAt = combatIntent.nextAttackAt;
    return;
  }
  
  // Ready to attack - execute basic attack (NOT slot 1 ability)
  executeBasicAttack(weapon, target);
  
  // Set next attack time (1.5s cadence) and track when cooldown started
  combatIntent.cooldownStartedAt = now;
  combatIntent.nextAttackAt = now + BASIC_ATTACK_CD_MS;
  combatIntent.lastSuccessAt = now;
  combatIntent.expiresAt = now + INTENT_TIMEOUT_MS; // Refresh timeout on success
  
  // Start CSS-driven swing timer animation (GPU accelerated)
  startSwingTimerAnimation();
  updateSwingTimerUI();
}

/**
 * Execute a basic attack using weapon.basic.damage
 * This is separate from weapon abilities (1-3)
 */
function executeBasicAttack(weapon, target) {
  if (!target || target.hp <= 0) return;
  if (!weapon) return;
  
  // Check spawn immunity
  if (hasSpawnImmunity(target)) {
    logCombat('Enemy is still materializing...');
    return;
  }
  
  // Provoke the target if passive
  provokeEnemy(target);
  
  const player = currentState.player;
  const basic = weapon.basic || {};
  
  // Calculate damage using basic attack damage (not ability damage)
  const baseDamage = basic.damage || weapon.baseDamage || 10;
  let damage = calculateBasicDamage(weapon, target, baseDamage);
  
  // Visual effects
  if (weapon.type === 'ranged') {
    showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().meleePlayer);
  } else {
    showMeleeSwipe(player.x, player.y, target.x, target.y, weapon.projectileColor || getColors().meleePlayer);
  }
  
  // Apply damage
  target.hp -= damage;
  markCombatEvent(); // Track combat activity for regen gating
  
  // Use crit flag from calculateBasicDamage
  const isCrit = !!weapon.__lastCrit;
  weapon.__lastCrit = false;
  showDamageNumber(target.x, target.y, damage, isCrit);
  logCombat(`${damage} damage with ${weapon.name || 'attack'}`);
  
  updateEnemyHealthBar(target);
  updateTargetFrame();
  
  if (target.hp <= 0) {
    handleEnemyDeath(target);
  }
}

/**
 * Calculate damage for basic attacks (uses weapon.basic.damage)
 * Simplified version of calculateDamage for basic attacks
 */
function calculateBasicDamage(weapon, target, baseDamage) {
  const player = currentState.player;
  const atk = player.atk || 0;
  const levelMult = 1 + (player.level - 1) * 0.05;
  
  // Get defense
  const defRaw = target.def ?? 0;
  const defMult = 100 / (100 + defRaw * DEF_K);
  
  // Vulnerability check
  const vulnMult = isVulnerable(target) ? 1.3 : 1.0;
  
  // Variance
  const variance = 0.9 + Math.random() * 0.2;
  
  // Crit check
  const luck = player.luck || 0;
  const critChance = 0.05 + luck * 0.02;
  const isCrit = Math.random() < critChance;
  const critMult = isCrit ? 1.5 : 1.0;
  weapon.__lastCrit = isCrit;
  
  // Final damage
  let damage = (baseDamage + atk) * levelMult * defMult * vulnMult * variance * critMult;
  return Math.max(1, Math.round(damage));
}

/**
 * Execute weapon ability intent (one-shot)
 */
function executeWeaponAbilityIntent(now) {
  let target = getIntentTarget();
  
  // Target invalid - try to acquire nearest
  if (!target || target.hp <= 0) {
    const nearestEnemy = findNearestEnemy();
    if (nearestEnemy) {
      combatIntent.targetId = nearestEnemy.id;
      target = nearestEnemy;
      selectTarget(target);
    } else {
      logCombat('No enemies nearby');
      clearCombatIntent();
      return;
    }
  }
  
  // Ensure target is selected
  if (currentTarget?.id !== target.id) {
    selectTarget(target);
  }
  
  // Check spawn immunity - schedule retry
  if (hasSpawnImmunity(target)) {
    combatIntent.retryAt = now + 200;
    return;
  }
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) {
    clearCombatIntent();
    return;
  }
  
  const slot = combatIntent.slot;
  const ability = weapon.abilities?.[slot];
  if (!ability) {
    clearCombatIntent();
    return;
  }
  
  // Check cooldown
  if (actionCooldowns[slot] > 0) {
    combatIntent.retryAt = now + 100;
    return;
  }
  
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, target.x, target.y);
  
  // Out of range - move to attack range
  if (dist > combatIntent.requiredRange) {
    if (!pendingAttack) {
      moveToAttackRange(target, combatIntent.requiredRange, `weaponAbility_${slot}`);
    }
    return;
  }
  
  // No LOS - move to attack range (for ranged weapons)
  if (combatIntent.requiresLOS && !hasLineOfSight(currentState, player.x, player.y, target.x, target.y)) {
    if (!pendingAttack) {
      moveToAttackRange(target, combatIntent.requiredRange, `weaponAbility_${slot}`);
    }
    return;
  }
  
  // Ready to execute ability - clear intent FIRST (one-shot)
  const intentSlot = slot;
  const wasAutoAttackEnabled = autoAttackEnabled;
  clearCombatIntent();
  
  // Execute the ability
  executeWeaponAbilityDirect(intentSlot);
  
  // ============================================
  // ABILITY WEAVING DESIGN CHOICE
  // ============================================
  // After a weapon ability, we immediately resume auto-attack with a FRESH intent.
  // This means nextAttackAt = 0, allowing an instant basic attack after the ability.
  // 
  // This is INTENTIONAL "ability weaving" - rewarding players who time abilities well.
  // The flow is: basic attack → ability → instant basic attack → normal 1.5s cadence
  // 
  // If you want SWING TIMER PRESERVATION instead (no instant attack after ability):
  // 1. Before clearCombatIntent(), snapshot: const savedNextAttackAt = combatIntent?.nextAttackAt
  // 2. After setAutoAttackIntent(), restore: combatIntent.nextAttackAt = savedNextAttackAt
  // ============================================
  if (wasAutoAttackEnabled && currentTarget && currentTarget.hp > 0) {
    setAutoAttackIntent(currentTarget);
  }
}

/**
 * Direct execution of weapon ability (bypasses intent system)
 * Used by intent system after move-to-range completes
 */
function executeWeaponAbilityDirect(slot) {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;
  
  const ability = weapon.abilities?.[slot];
  if (!ability) return;
  
  // Enable combat flags
  autoAttackEnabled = true;
  inCombat = true;
  
  if (currentTarget) {
    provokeEnemy(currentTarget);
  }
  
  // Execute ability based on ID
  switch (ability.id) {
    case 'rifle_burst':
      executeRifleBurst(weapon, ability);
      break;
    case 'rifle_suppress':
      executeRifleSuppress(weapon, ability);
      break;
    case 'rifle_overcharge':
      executeRifleOvercharge(weapon, ability);
      break;
    case 'sword_cleave':
      executeSwordCleave(weapon, ability);
      break;
    case 'sword_lunge':
      executeSwordLunge(weapon, ability);
      break;
    case 'sword_shockwave':
      executeSwordShockwave(weapon, ability);
      break;
    default:
      executeEnhancedAttack(weapon, { 
        name: ability.name, 
        damage: ability.damage || weapon.baseDamage,
        onHit: ability.onHit
      });
  }
  
  // Set ability cooldown
  actionCooldowns[slot] = ability.cooldownMs || 6000;
  actionMaxCooldowns[slot] = ability.cooldownMs || 6000;
  
  // Trigger GCD
  triggerGcd();
}

// Debug helpers
if (typeof window !== 'undefined') {
  /**
   * Get current combat intent with computed status.
   * Status: no_intent | no_target | invalid_target | waiting_range | waiting_los | waiting_cd | ready | executing
   */
  window.VETUU_INTENT = () => {
    if (!combatIntent) return { status: 'no_intent', intent: null };
    
    const now = nowMs();
    const target = getIntentTarget();
    const targetCheck = isInvalidCombatTarget(target, now);
    
    // Compute status
    let status = 'ready';
    if (!target) {
      status = 'no_target';
    } else if (targetCheck.invalid) {
      status = `invalid_target:${targetCheck.reason}`;
    } else if (combatIntent.nextAttackAt > now) {
      status = 'waiting_cd';
    } else {
      // Check range/LOS
      const player = currentState?.player;
      if (player && target) {
        const dist = Math.hypot(target.x - player.x, target.y - player.y);
        if (dist > combatIntent.requiredRange) {
          status = 'waiting_range';
        } else if (combatIntent.requiresLOS && !hasLineOfSight(currentState, player.x, player.y, target.x, target.y)) {
          status = 'waiting_los';
        }
      }
    }
    
    return {
      status,
      type: combatIntent.type,
      slot: combatIntent.slot,
      targetId: combatIntent.targetId,
      targetName: target?.name,
      lastSuccessAt: combatIntent.lastSuccessAt,
      nextAttackAt: combatIntent.nextAttackAt,
      retryAt: combatIntent.retryAt,
      expiresAt: combatIntent.expiresAt,
      msUntilReady: Math.max(0, (combatIntent.nextAttackAt || 0) - now),
      msUntilExpiry: Math.max(0, combatIntent.expiresAt - now)
    };
  };
  
  window.VETUU_SENSE = () => {
    const p = currentState?.player;
    const now = nowMs();
    return {
      sense: p?.sense,
      maxSense: p?.maxSense,
      lastCombatEventAt,
      msSinceCombat: lastCombatEventAt ? Math.round(now - lastCombatEventAt) : null,
      regenMode: lastCombatEventAt && (now - lastCombatEventAt) <= COMBAT_TIMEOUT ? 'in_combat' : 'out_of_combat',
      lastHitTime,
    };
  };
  
  window.VETUU_BURST = () => ({
    activeTimers: activeBurstTimers.length,
    timers: activeBurstTimers.map(t => ({ targetId: t.targetId }))
  });
  
  /**
   * Get current target info with validity check.
   */
  window.VETUU_TARGET = () => {
    if (!currentTarget) return { status: 'no_target', target: null };
    
    const now = nowMs();
    const check = isInvalidCombatTarget(currentTarget, now);
    
    return {
      status: check.invalid ? `invalid:${check.reason}` : 'valid',
      id: currentTarget.id,
      name: currentTarget.name,
      hp: currentTarget.hp,
      maxHP: getMaxHP(currentTarget),
      state: currentTarget.state,
      isRetreating: currentTarget.isRetreating,
      isEngaged: currentTarget.isEngaged,
      brokenOffUntil: currentTarget.brokenOffUntil,
      spawnImmunityUntil: currentTarget.spawnImmunityUntil,
      _deathHandled: currentTarget._deathHandled
    };
  };
  
  /**
   * Get combat system state overview.
   */
  window.VETUU_COMBAT = () => ({
    inCombat,
    autoAttackEnabled,
    currentWeapon,
    hasTarget: !!currentTarget,
    hasIntent: !!combatIntent,
    pendingAttack: !!pendingAttack,
    provokedCount: provokedEnemies.size,
    activeBurstTimers: activeBurstTimers.length,
    attackerSlots: attackerSlots.size
  });
}

// ============================================
// TARGETING
// ============================================
export function handleTargeting(action, data) {
  switch (action) {
    case 'cycle': cycleTarget(); break;
    case 'cycleFriendly': cycleFriendlyTarget(); break;
    case 'select': selectTarget(data); break;
    case 'selectNpc': selectNpcTarget(data); break;
    case 'selectObject': selectObjectTarget(data); break;
    case 'clear': clearTarget(); break;
    case 'attack': 
      // If enemy data provided, select it first then start auto-attack
      if (data && data.hp > 0) {
        selectTarget(data);
      }
      if (currentTarget) {
        // Set persistent combat intent and try to execute
        const result = setAutoAttackIntent(currentTarget);
        if (result.success) {
          autoAttackEnabled = true;
          inCombat = true;
          tryExecuteCombatIntent();
        } else {
          // Target is invalid (retreating, dead, etc.)
          logCombat(result.reason === 'retreating' ? 'Target is retreating.' : 'Invalid target.');
          clearTarget();
        }
      }
      break;
    case 'special': playerSpecial(); break;
    case 'cycleWeapon': cycleWeapon(); break;
    
    // Move to and interact with NPC/object
    case 'interactWith': 
      handleInteractWith(data);
      break;
    
    // Move to and interact with current target (E key)
    case 'interactWithTarget':
      handleInteractWithCurrentTarget();
      break;
    
    // Legacy action handler (still works with old format)
    case 'action': useAction(data); break;
    
    // NEW: Weapon abilities (slots 1-3, no Sense cost)
    case 'weaponAbility': 
      useWeaponAbility(data); 
      break;
    
    // NEW: Sense abilities (slots 4-6, spends Sense)
    case 'senseAbility':
      useSenseAbility(data);
      break;
    
    // NEW: Utility abilities (sprint, heal)
    case 'utility':
      useUtilityAbility(data);
      break;
  }
}

function cycleTarget() {
  // Filter to enemies that are alive and visible (fog + viewport)
  const enemies = currentState.runtime.activeEnemies.filter(e => 
    e.hp > 0 && isActorVisible(e)
  );
  
  if (enemies.length === 0) {
    clearTarget();
    return;
  }

  const player = currentState.player;
  enemies.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });

  const currentIndex = currentTarget ? enemies.findIndex(e => e.id === currentTarget.id) : -1;
  const nextIndex = (currentIndex + 1) % enemies.length;

  selectTarget(enemies[nextIndex]);
}

function cycleFriendlyTarget() {
  // Build combined list of NPCs and interactive objects
  const targets = [];
  
  // Add visible NPCs
  for (const npc of currentState.entities?.npcs || []) {
    if (npc.flags?.hidden) continue;
    if (npc.requires?.flag && !currentState.flags?.[npc.requires.flag]) continue;
    if (!isActorVisible(npc)) continue;
    targets.push({ type: 'npc', entity: npc, x: npc.x, y: npc.y });
  }
  
  // Add interactive objects
  for (const obj of currentState.map?.objects || []) {
    if (!obj.interact) continue;
    if (!isActorVisible(obj)) continue;
    targets.push({ type: 'object', entity: obj, x: obj.x, y: obj.y });
  }
  
  if (targets.length === 0) {
    clearNpcTarget();
    clearObjectTarget();
    return;
  }

  // Sort by distance
  const player = currentState.player;
  targets.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });

  // Find current index (check both NPC and object targets)
  let currentIndex = -1;
  if (currentNpcTarget) {
    currentIndex = targets.findIndex(t => t.type === 'npc' && t.entity.id === currentNpcTarget.id);
  } else if (currentObjectTarget) {
    currentIndex = targets.findIndex(t => t.type === 'object' && t.entity.id === currentObjectTarget.id);
  }
  
  const nextIndex = (currentIndex + 1) % targets.length;
  const next = targets[nextIndex];

  if (next.type === 'npc') {
    selectNpcTarget(next.entity);
  } else {
    selectObjectTarget(next.entity);
  }
}

function selectTarget(enemy) {
  // Clear any NPC target first
  clearNpcTarget();
  
  if (currentTarget) {
    const prevEl = document.querySelector(`[data-enemy-id="${currentTarget.id}"]`);
    if (prevEl) prevEl.classList.remove('targeted');
  }

  currentTarget = enemy;

  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (el) el.classList.add('targeted');

  updateTargetFrame();
  updateActionBarState();
}

export function selectNpcTarget(npc) {
  // Clear any enemy target first
  clearTarget();
  
  if (currentNpcTarget) {
    const prevEl = getNpcEl(currentNpcTarget.id);
    if (prevEl) prevEl.classList.remove('targeted');
  }
  
  currentNpcTarget = npc;

  const el = getNpcEl(npc.id);
  if (el) el.classList.add('targeted');

  updateTargetFrame();
  updateActionBarState();
}

function clearNpcTarget() {
  if (currentNpcTarget) {
    const el = getNpcEl(currentNpcTarget.id);
    if (el) el.classList.remove('targeted');
  }
  currentNpcTarget = null;
}

function selectObjectTarget(obj) {
  // Clear any other targets
  clearTarget();
  clearNpcTarget();
  
  if (currentObjectTarget) {
    const prevEl = document.querySelector(`[data-obj-id="${currentObjectTarget.id}"]`);
    if (prevEl) prevEl.classList.remove('targeted');
  }

  currentObjectTarget = obj;

  const el = document.querySelector(`[data-obj-id="${obj.id}"]`);
  if (el) el.classList.add('targeted');

  updateTargetFrame();
  updateActionBarState();
}

function clearObjectTarget() {
  if (currentObjectTarget) {
    const el = document.querySelector(`[data-obj-id="${currentObjectTarget.id}"]`);
    if (el) el.classList.remove('targeted');
  }
  currentObjectTarget = null;
}

/**
 * Handle double-click move-to-and-interact with NPC/object.
 */
async function handleInteractWith(data) {
  const { type, target, x, y } = data;
  
  // Import movement function
  const { createPathTo } = await import('./movement.js');
  
  // Path to the target
  createPathTo(x, y, true);
  
  // Store pending interaction
  currentState.runtime.pendingInteraction = { type, target };
}

/**
 * Handle E key - move to and interact with current friendly target.
 */
async function handleInteractWithCurrentTarget() {
  if (currentNpcTarget) {
    const { createPathTo } = await import('./movement.js');
    createPathTo(currentNpcTarget.x, currentNpcTarget.y, true);
    currentState.runtime.pendingInteraction = { type: 'npc', target: currentNpcTarget };
  } else if (currentObjectTarget) {
    const { createPathTo } = await import('./movement.js');
    createPathTo(currentObjectTarget.x, currentObjectTarget.y, true);
    currentState.runtime.pendingInteraction = { type: 'object', target: currentObjectTarget };
  }
}

/**
 * Check if any focused target is too far away (outside viewport + 10% buffer).
 * If so, silently drop focus on that target.
 */
function checkTargetDistance() {
  const vp = getViewportInfo();
  if (!vp) return;
  
  const { vw, vh, camX, camY, zoom } = vp;
  
  // Add 10% buffer outside viewport
  const bufferX = vw * 0.1;
  const bufferY = vh * 0.1;
  
  // Helper to check if an actor is outside viewport + buffer
  const isOutsideViewport = (actor) => {
    if (!actor) return false;
    const screenX = (actor.x * TILE_SIZE - camX) * zoom;
    const screenY = (actor.y * TILE_SIZE - camY) * zoom;
    return screenX < -bufferX || screenX > vw + bufferX ||
           screenY < -bufferY || screenY > vh + bufferY;
  };
  
  // Check enemy target
  if (currentTarget && isOutsideViewport(currentTarget)) {
    const el = document.querySelector(`[data-enemy-id="${currentTarget.id}"]`);
    if (el) el.classList.remove('targeted');
    currentTarget = null;
    updateTargetFrame();
    updateActionBarState();
  }
  
  // Check NPC target
  if (currentNpcTarget && isOutsideViewport(currentNpcTarget)) {
    const prevEl = getNpcEl(currentNpcTarget.id);
    if (prevEl) prevEl.classList.remove('targeted');
    currentNpcTarget = null;
  }
  
  // Check object target
  if (currentObjectTarget && isOutsideViewport(currentObjectTarget)) {
    const prevEl = document.querySelector(`[data-obj-id="${currentObjectTarget.id}"]`);
    if (prevEl) prevEl.classList.remove('targeted');
    currentObjectTarget = null;
  }
}

function clearTarget() {
  if (currentTarget) {
    const el = document.querySelector(`[data-enemy-id="${currentTarget.id}"]`);
    if (el) el.classList.remove('targeted');
  }
  currentTarget = null;
  
  // Full disengage when target is explicitly cleared (Escape key)
  clearCombatIntent();
  autoAttackEnabled = false;
  
  // Don't end combat here - let processAutoAttack handle combat state
  // It will check for engaged/provoked enemies and end combat when appropriate
  
  clearNpcTarget();
  clearObjectTarget();
  updateTargetFrame();
  updateActionBarState();
}

export function getCurrentTarget() {
  return currentTarget;
}

export function spawnBoss(state, bossDef) {
  const boss = {
    id: bossDef.id,
    name: bossDef.name,
    type: bossDef.type,
    level: bossDef.level,
    x: bossDef.x,
    y: bossDef.y,
    hp: calculateEnemyHP(bossDef.level) * 3,
    maxHP: calculateEnemyHP(bossDef.level) * 3,
    atk: calculateEnemyAtk(bossDef.level) * 1.5,
    def: calculateEnemyDef(bossDef.level),
    cooldownUntil: 0,
    moveCooldown: 0,
    isBoss: true,
    color: getColors().boss
  };

  state.runtime.activeEnemies.push(boss);
  renderEnemies(state);
  return boss;
}

// ============================================
// ENEMY STAT CALCULATIONS
// ============================================
function calculateEnemyHP(level) { return 20 + level * 8; }
function calculateEnemyAtk(level) { return 3 + Math.floor(level * 0.8); }
function calculateEnemyDef(level) { return 2 + Math.floor(level * 0.5); }

// ============================================
// DEATH HANDLING
// ============================================
async function handleEnemyDeath(enemy) {
  // Idempotency guard: prevent double-death processing (e.g., from burst attacks)
  if (enemy._deathHandled) {
    if (COMBAT_DEBUG) console.log(`%c[DEATH BLOCKED] ${enemy.name} - already handled`, 'color: orange');
    return;
  }
  enemy._deathHandled = true;
  if (COMBAT_DEBUG) console.log(`%c[DEATH] ${enemy.name} (id: ${enemy.id})`, 'color: lime');
  
  // Cancel any remaining burst timers targeting this enemy
  const cancelledTimers = activeBurstTimers.filter(t => t.targetId === enemy.id).length;
  clearBurstTimers(enemy.id);
  if (COMBAT_DEBUG && cancelledTimers > 0) {
    console.log(`%c[BURST] Cancelled ${cancelledTimers} remaining shot(s)`, 'color: cyan');
  }
  
  logCombat(`${enemy.name} defeated!`);

  // Remove from provoked set and attacker slots
  provokedEnemies.delete(enemy.id);
  releaseAttackerSlot(enemy);
  
  // ============================================
  // IMMEDIATE TARGET REACQUISITION (before any async operations)
  // This MUST happen synchronously to avoid race conditions with combat tick
  // ============================================
  if (currentTarget?.id === enemy.id) {
    currentTarget = null;
    
    if (inCombat && autoAttackEnabled) {
      const nextTarget = findNextCombatTarget();
      if (nextTarget) {
        selectTarget(nextTarget);
        // Continue auto-attack on the new target immediately
        setAutoAttackIntent(nextTarget);
        tryExecuteCombatIntent();
      }
    }
    
    updateTargetFrame();
    updateActionBarState();
  }

  // ============================================
  // COMEBACK MECHANIC - XP Scaling
  // ============================================
  // Killing enemies above your level grants bonus XP
  // Killing enemies far below your level grants reduced XP
  const playerLevel = currentState.player.level;
  const levelDiff = enemy.level - playerLevel;
  
  let baseXP = 10 + enemy.level * 5;
  let xpMultiplier = 1.0;
  
  if (levelDiff >= 5) {
    // Major challenge: +50% XP bonus
    xpMultiplier = 1.5;
  } else if (levelDiff >= 2) {
    // Tough fight: +25% XP bonus
    xpMultiplier = 1.25;
  } else if (levelDiff <= -5) {
    // Trivial: -50% XP (minimum 25% of base)
    xpMultiplier = 0.5;
  } else if (levelDiff <= -3) {
    // Easy: -25% XP
    xpMultiplier = 0.75;
  }
  
  const alphaBonus = enemy.isAlpha ? Math.floor(baseXP * 0.5) : 0;
  const bossBonus = enemy.isBoss ? 200 : 0;
  const xp = Math.floor((baseXP + alphaBonus + bossBonus) * xpMultiplier);
  
  const { grantXP, showToast } = await import('./game.js');
  const { updateQuestProgress } = await import('./quests.js');
  
  grantXP(xp);
  
  // Show bonus indicator for challenging kills
  if (levelDiff >= 2) {
    showToast(`Challenge bonus! +${Math.floor((xpMultiplier - 1) * 100)}% XP`, 'xp');
  }

  currentState.runtime.activeEnemies = currentState.runtime.activeEnemies.filter(e => e.id !== enemy.id);

  // Clear melee attacker tracking if it was this enemy
  if (lastMeleeAttacker === enemy.id) {
    lastMeleeAttacker = null;
  }

  // Notify spawn director of death (for respawn tracking)
  try {
    const { onEnemyDeath } = await import('./spawnDirector.js');
    onEnemyDeath(enemy);
  } catch (e) {
    console.warn('SpawnDirector not available:', e);
  }

  // Update kill quest progress
  updateQuestProgress(currentState, 'kill', {
    enemyType: enemy.type,
    enemyName: enemy.name,
    spawnId: enemy.spawnId,
    spawnerId: enemy.spawnerId,
    packId: enemy.packId,
    isAlpha: enemy.isAlpha,
    isBoss: enemy.isBoss,
    level: enemy.level
  });

  if (enemy.isBoss) {
    currentState.runtime.defeatedBosses.add(enemy.id);
    updateQuestProgress(currentState, 'boss', { bossId: enemy.id });
    showToast('Boss defeated!', 'quest');
    }
  // Note: Respawning is now handled by the Spawn Director

  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (el) {
    el.classList.add('dying');
    
    // Remove on animation end, with fallback timeout in case animation doesn't fire
    const removeEl = () => {
      if (el.parentNode) el.remove();
    };
    el.addEventListener('animationend', removeEl, { once: true });
    
    // Fallback: force remove after 100ms if animationend didn't fire
    setTimeout(removeEl, 100);
  }

  saveGame(currentState);
}

async function handlePlayerDeath() {
  const { showToast, updateHUD, updateMinimapCorpse } = await import('./game.js');
  const { showDialogue } = await import('./dialogue.js');
  const { updateCamera } = await import('./render.js');
  const { renderFog, revealAround } = await import('./fog.js');

  autoAttackEnabled = false;
  inCombat = false;
  clearTarget();

  // Store corpse location BEFORE teleporting
  corpseLocation = {
    x: currentState.player.x,
    y: currentState.player.y
  };

  logCombat('You have fallen...');
  showToast('You have fallen...', 'error');

  // Immediately teleport to base (medical bay near Vela)
  const spawnX = DRYCROSS_CENTER.x;
  const spawnY = DRYCROSS_CENTER.y;
  
  currentState.player.hp = 1; // Barely alive, in medical care
  currentState.player.x = spawnX;
  currentState.player.y = spawnY;

  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.classList.add('downed'); // Visual indicator that we're in the med bay
    playerEl.style.transition = 'none';
    playerEl.style.transform = actorTransform(spawnX, spawnY);
    playerEl.offsetHeight; // Force reflow
    playerEl.style.transition = '';
  }

  // Update camera and fog for new position (instant snap, no transition)
  updateCamera(currentState, 0);
  revealAround(currentState, spawnX, spawnY);
  renderFog(currentState);
  updateHUD();
  updatePlayerHealthBar();

  // Show corpse on minimap
  updateMinimapCorpse(corpseLocation.x, corpseLocation.y);

  // Show death dialogue after a brief moment
  setTimeout(() => {
    showDialogue(currentState, 'dlg_vela_death');
  }, 1000);
}

export async function reviveAtBase() {
  const { showToast, updateHUD, clearMinimapCorpse } = await import('./game.js');
  const { updateCamera } = await import('./render.js');
    const { renderFog, revealAround } = await import('./fog.js');

  isGhostMode = false;
  corpseLocation = null;
  removeCorpseMarker();
  clearMinimapCorpse();

  // Revive with half HP at base
  const spawnX = DRYCROSS_CENTER.x;
  const spawnY = DRYCROSS_CENTER.y;
  
    currentState.player.hp = Math.floor(getMaxHP(currentState.player) / 2);
  currentState.player.x = spawnX;
  currentState.player.y = spawnY;

  // Clear nearby enemies
    currentState.runtime.activeEnemies = currentState.runtime.activeEnemies.filter(e => {
    return distCoords(e.x, e.y, spawnX, spawnY) > 15;
    });

    const playerEl = document.getElementById('player');
    if (playerEl) {
    playerEl.classList.remove('ghost', 'downed');
    playerEl.style.transition = 'none';
    playerEl.style.transform = actorTransform(spawnX, spawnY);
    playerEl.offsetHeight;
    playerEl.style.transition = '';
    }

    updateCamera(currentState, 0); // Instant snap, no transition
  revealAround(currentState, spawnX, spawnY);
    renderFog(currentState);
    renderEnemies(currentState);
    updateHUD();
    updatePlayerHealthBar();

  showToast('You wake up in the medical bay...', 'item');
    saveGame(currentState);
}

export async function startCorpseRun() {
  const { showToast, updateHUD } = await import('./game.js');

  isGhostMode = true;

  // Player is already at base from handlePlayerDeath
  // Just switch from downed to ghost mode
  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.classList.remove('downed');
    playerEl.classList.add('ghost');
  }

  // Create world corpse marker at death location
  createCorpseMarker(corpseLocation.x, corpseLocation.y);

  updateHUD();
  updatePlayerHealthBar();

  showToast('Find your corpse to revive...', 'quest');
  saveGame(currentState);
}

export function checkCorpseReached() {
  if (!isGhostMode || !corpseLocation) return false;

  const player = currentState.player;
  const dist = distCoords(player.x, player.y, corpseLocation.x, corpseLocation.y);

  if (dist <= 1.5) {
    reviveAtCorpse();
    return true;
  }
  return false;
}

async function reviveAtCorpse() {
  const { showToast, updateHUD, clearMinimapCorpse } = await import('./game.js');
  const { updateCamera } = await import('./render.js');

  isGhostMode = false;
  
  // Revive at corpse with FULL HP (reward for corpse run)
  currentState.player.hp = getMaxHP(currentState.player);
  currentState.player.x = corpseLocation.x;
  currentState.player.y = corpseLocation.y;

  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.classList.remove('ghost', 'downed');
    // Update position to corpse location
    playerEl.style.transition = 'none';
    playerEl.style.transform = actorTransform(corpseLocation.x, corpseLocation.y);
    playerEl.offsetHeight;
    playerEl.style.transition = '';
    
    // Start immunity period with visual indicator
    playerEl.classList.add('immune');
  }

  // Enable immunity
  startImmunity();

  removeCorpseMarker();
  clearMinimapCorpse();
  
  corpseLocation = null;

  updateCamera(currentState, 0); // Instant snap, no transition
  updateHUD();
  updatePlayerHealthBar();

  showToast('You pull yourself back together! (5s immunity)', 'item');
  logCombat('Revived at corpse with full health. 5 second immunity.');
  saveGame(currentState);
}

function startImmunity() {
  playerImmunityActive = true;
  autoAttackEnabled = false; // Disable auto-attack during immunity
  
  // Clear any existing immunity timeout
  if (immunityTimeout) {
    clearTimeout(immunityTimeout);
  }
  
  // End immunity after duration
  immunityTimeout = setTimeout(() => {
    endImmunity();
  }, IMMUNITY_DURATION);
}

function endImmunity() {
  playerImmunityActive = false;
  immunityTimeout = null;
  
  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.classList.remove('immune');
  }
  
  import('./game.js').then(({ showToast }) => {
    showToast('Immunity ended', 'info');
  });
  logCombat('Immunity period ended.');
}

export function isPlayerImmune() {
  return playerImmunityActive;
}

function createCorpseMarker(x, y) {
  const world = document.getElementById('world');
  if (!world) return;

  removeCorpseMarker();

  const marker = document.createElement('div');
  marker.id = 'corpse-marker';
  marker.className = 'corpse-marker';
  marker.style.transform = `translate3d(${x * 24}px, ${y * 24}px, 0)`;
  marker.title = 'Click to path to your corpse';

  // Click to path to corpse
  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isGhostMode && corpseLocation) {
      import('./movement.js').then(({ createPathTo }) => {
        createPathTo(corpseLocation.x, corpseLocation.y, false);
      });
    }
  });

  world.appendChild(marker);
}

function removeCorpseMarker() {
  const marker = document.getElementById('corpse-marker');
  if (marker) marker.remove();
}

export function isInGhostMode() {
  return isGhostMode;
}

export function getCorpseLocation() {
  return corpseLocation;
}

// ============================================
// ENEMY RENDERING
// ============================================
/**
 * Full re-render of all enemies. Clears DOM cache and rebuilds.
 * Should only be called on init, load, or major state changes (respawn).
 * For incremental spawns, use createEnemyElement() instead.
 */
export function renderEnemies(state) {
  perfStart('enemy:render');
  
  const actorLayer = document.getElementById('actor-layer');
  if (!actorLayer) {
    perfEnd('enemy:render');
    return;
  }

  // Clear DOM cache and visual state cache (full rebuild)
  enemyEls.clear();
  enemyVisualState.clear();
  
  actorLayer.querySelectorAll('.enemy').forEach(el => el.remove());

  const playerLevel = state.player.level;

  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;
    
    const el = createEnemyElement(enemy, playerLevel);
    actorLayer.appendChild(el);
    
    // Cache the DOM reference
    enemyEls.set(enemy.id, el);
  }
  
  // Re-enable transitions after initial placement (CSS uses --enemy-move-speed variable)
  requestAnimationFrame(() => {
    for (const el of enemyEls.values()) {
      el.style.transition = '';
    }
  });
  
  perfEnd('enemy:render');
}

/**
 * Create a single enemy DOM element. Used by both renderEnemies and incremental spawn.
 * @param {object} enemy - Enemy data
 * @param {number} playerLevel - Current player level (for badge color)
 * @returns {HTMLElement} The enemy element
 */
export function createEnemyElement(enemy, playerLevel) {
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.nomad;
  const weapon = ENEMY_WEAPONS[config.weapon];
  const isPassive = isEnemyPassive(enemy) && !provokedEnemies.has(enemy.id);

  const el = document.createElement('div');
  
  // Build class list including status effects
  const classes = ['actor', 'enemy'];
  if (enemy.isBoss) classes.push('boss');
  if (enemy.isAlpha) classes.push('alpha');
  if (isPassive) classes.push('passive');
  if (isStunned(enemy)) classes.push('is-stunned');
  if (isRooted(enemy)) classes.push('is-rooted');
  if (isSlowed(enemy)) classes.push('is-slowed');
  if (isVulnerable(enemy)) classes.push('is-vulnerable');
  if (isImmune(enemy)) classes.push('is-immune');
  
  el.className = classes.join(' ');
  el.dataset.enemyId = enemy.id;
  if (enemy.isAlpha) el.dataset.alpha = 'true';
  if (isPassive) el.dataset.passive = 'true';
  
  const moveSpeed = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  // Set CSS variables for enemy-specific values
  el.style.setProperty('--enemy-move-speed', `${moveSpeed}ms`);
  el.style.setProperty('--sprite-idle', `url('${SPRITES.actor.idle}')`);
  
  // Shadow and sprite elements
  const shadow = document.createElement('div');
  shadow.className = 'shadow';
  el.appendChild(shadow);
  
  const sprite = document.createElement('div');
  sprite.className = 'sprite';
  el.appendChild(sprite);
  
  // Initial position without transition
  el.style.transition = 'none';
  el.style.transform = actorTransform(enemy.x, enemy.y);
  
  el.dataset.moveSpeed = moveSpeed;

  const levelDiff = enemy.level - playerLevel;
  let levelClass = 'normal';
  let levelIcon = enemy.level;

  if (levelDiff >= 10) {
    levelClass = 'impossible';
    levelIcon = '💀';
  } else if (levelDiff >= 5) {
    levelClass = 'very-hard';
  } else if (levelDiff >= 2) {
    levelClass = 'hard';
  } else if (levelDiff <= -5) {
    levelClass = 'trivial';
  } else if (levelDiff <= -2) {
    levelClass = 'easy';
  }

  const badge = document.createElement('div');
  badge.className = `enemy-level-badge ${levelClass} ${enemy.isAlpha ? 'alpha-badge' : ''} ${isPassive ? 'passive-badge' : ''}`;
  badge.textContent = enemy.isAlpha ? `α${enemy.level}` : levelIcon;
  badge.title = `Level ${enemy.level} ${enemy.name}${enemy.isAlpha ? ' (Alpha)' : ''}${isPassive ? ' (Passive)' : ''}`;
  el.appendChild(badge);

  const hpBar = document.createElement('div');
  hpBar.className = 'enemy-hp-bar';
  const hpFill = document.createElement('span');
  hpFill.className = 'enemy-hp-fill';
  hpFill.style.setProperty('--hp-pct', getHPPercent(enemy));
  hpBar.appendChild(hpFill);
  el.appendChild(hpBar);

  // Track for double-click detection
  let lastClickTime = 0;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    
    const now = Date.now();
    const isDoubleClick = (now - lastClickTime) < 400;
    lastClickTime = now;
    
    if (isDoubleClick) {
      // Double-click: select and auto-attack
      selectTarget(enemy);
      if (currentTarget && currentTarget.hp > 0) {
        const result = setAutoAttackIntent(currentTarget);
        if (result.success) {
          autoAttackEnabled = true;
          inCombat = true;
          tryExecuteCombatIntent();
        }
      }
    } else {
      // Single click: just select
      selectTarget(enemy);
    }
  });

  if (currentTarget?.id === enemy.id) {
    el.classList.add('targeted');
  }

  return el;
}

/**
 * Add a single enemy to the DOM (incremental spawn).
 * More efficient than calling renderEnemies() for each spawn.
 * @param {object} enemy - Enemy to add
 * @param {number} playerLevel - Current player level
 */
export function addEnemyElement(enemy, playerLevel) {
  const actorLayer = document.getElementById('actor-layer');
  if (!actorLayer) return;
  
  const el = createEnemyElement(enemy, playerLevel);
  actorLayer.appendChild(el);
  
  // Cache the reference
  enemyEls.set(enemy.id, el);
  
  // Enable transition after placement
  requestAnimationFrame(() => {
    el.style.transition = '';
  });
}

/**
 * Remove an enemy element from DOM (on death/despawn).
 * @param {string} enemyId - ID of enemy to remove
 */
export function removeEnemyElement(enemyId) {
  const el = enemyEls.get(enemyId);
  if (el) {
    el.remove();
    enemyEls.delete(enemyId);
    enemyVisualState.delete(enemyId);
  }
}

// Note: updateEnemyVisuals() is defined earlier in the file with comprehensive logic

function updateEnemyHealthBar(enemy) {
  // Use cached DOM reference
  const el = enemyEls.get(enemy.id);
  const fill = el?.querySelector('.enemy-hp-fill');
  if (fill) {
    fill.style.setProperty('--hp-pct', getHPPercent(enemy));
  }
  
  // If this enemy is the current target, also update the target frame
  if (currentTarget && currentTarget.id === enemy.id) {
    const frame = document.getElementById('target-frame');
    if (frame) {
      const hpFill = frame.querySelector('.frame-hp-fill');
      const hpText = frame.querySelector('.frame-hp-text');
      const targetMax = getMaxHP(enemy);
      if (hpFill) hpFill.style.setProperty('--hp-pct', getHPPercent(enemy));
      if (hpText) hpText.textContent = `${Math.max(0, enemy.hp)}/${targetMax}`;
    }
  }
}

// Update enemy element with current status effect classes
function updateEnemyStatusEffects(enemy) {
  // Use cached DOM reference instead of querySelector
  const el = enemyEls.get(enemy.id);
  if (!el) return;
  
  // Toggle status effect classes
  el.classList.toggle('is-stunned', isStunned(enemy));
  el.classList.toggle('is-rooted', isRooted(enemy));
  el.classList.toggle('is-slowed', isSlowed(enemy));
  el.classList.toggle('is-vulnerable', isVulnerable(enemy));
  el.classList.toggle('is-immune', isImmune(enemy));
  el.classList.toggle('is-burning', isBurning(enemy));
}

// Tick all enemy effects and update visuals
function tickAllEnemyEffects() {
  const t = nowMs();
  const enemies = currentState.runtime.activeEnemies;
  if (!enemies || enemies.length === 0) return;
  
  const px = currentState.player.x;
  const py = currentState.player.y;
  
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.hp <= 0) continue;
    
    // Tick status effects (must happen for all enemies regardless of distance)
    tickEffects(enemy);
    
    // Process burn damage (DoT)
    if (isBurning(enemy) && enemy.effects) {
      const burnTickInterval = enemy.effects.burnTickInterval || 500;
      const timeSinceLastTick = t - (enemy.effects.burnLastTick || 0);
      
      if (timeSinceLastTick >= burnTickInterval) {
        const burnDuration = enemy.effects.burnUntil - (enemy.effects.burnLastTick || t);
        const totalTicks = Math.ceil(burnDuration / burnTickInterval);
        const totalDamagePercent = enemy.effects.burnDamagePercent || 10;
        const damagePerTick = Math.ceil((getMaxHP(enemy) * totalDamagePercent / 100) / totalTicks);
        
        enemy.hp = Math.max(0, enemy.hp - damagePerTick);
        enemy.effects.burnLastTick = t;
        
        // Show burn damage number
        showDamageNumber(enemy.x, enemy.y, damagePerTick, false, false, true); // isBurn=true
        updateEnemyHealthBar(enemy);
        
        if (enemy.hp <= 0) {
          handleEnemyDeath(enemy);
          continue;
        }
      }
    }
    
    // Skip visual updates for distant enemies (off-screen)
    const dx = Math.abs(enemy.x - px);
    const dy = Math.abs(enemy.y - py);
    if (dx > VISUAL_UPDATE_RANGE || dy > VISUAL_UPDATE_RANGE) continue;
    
    updateEnemyStatusEffects(enemy);
    
    // Use cached DOM reference
    const el = enemyEls.get(enemy.id);
    if (!el) continue;
    
    // Sync spawn immunity visual state
    const immuneRemaining = getSpawnImmunityRemaining(enemy, t);
    el.classList.toggle('spawn-immune', immuneRemaining > 0);
    
    // Sync retreating visual
    el.classList.toggle('retreating', !!enemy.isRetreating);
    
    // Sync engaged visual
    el.classList.toggle('engaged', !!(enemy.isEngaged || enemy.state === 'ENGAGED'));
  }
}

// ============================================
// UI UPDATES
// ============================================
// Cached player health bar elements
let playerHealthEls = null;

function getPlayerHealthEls() {
  if (!playerHealthEls) {
    playerHealthEls = {
      fill: document.getElementById('player-hp-fill'),
      text: document.getElementById('player-hp-text'),
      mainFill: document.getElementById('hp-fill'),
      mainText: document.getElementById('hp-text'),
      playerEl: document.getElementById('player'),
    };
  }
  return playerHealthEls;
}

function updatePlayerHealthBar() {
  const player = currentState.player;
  const max = getMaxHP(player);
  const pct = getHPPercent(player);
  const els = getPlayerHealthEls();
  
  // Update player frame (portrait)
  if (els.fill) els.fill.style.setProperty('--hp-pct', pct);
  if (els.text) els.text.textContent = `${player.hp}/${max}`;

  // Update main HUD bar
  if (els.mainFill) els.mainFill.style.setProperty('--pct', pct);
  if (els.mainText) els.mainText.textContent = `${player.hp}/${max}`;
  
  // Update player sprite health bar (above character)
  if (els.playerEl) {
    els.playerEl.style.setProperty('--player-hp-pct', pct);
  }
}

function updatePlayerSenseBar() {
  const player = currentState.player;
  const sensePct = (player.sense / player.maxSense) * 100;
  
  const fill = document.getElementById('player-sense-fill');
  const text = document.getElementById('player-sense-text');
  if (fill) fill.style.setProperty('--sense-pct', sensePct);
  if (text) text.textContent = `${player.sense}/${player.maxSense}`;

  const mainFill = document.getElementById('sense-fill');
  const mainText = document.getElementById('sense-text');
  if (mainFill) mainFill.style.setProperty('--pct', sensePct);
  if (mainText) mainText.textContent = `${player.sense}/${player.maxSense}`;
}

// Cached target frame elements
let targetFrameEls = null;

function getTargetFrameEls() {
  if (!targetFrameEls) {
    const frame = document.getElementById('target-frame');
    if (!frame) return null;
    targetFrameEls = {
      frame,
      name: frame.querySelector('.frame-name'),
      level: frame.querySelector('.frame-level'),
      hpFill: frame.querySelector('.frame-hp-fill'),
      hpText: frame.querySelector('.frame-hp-text'),
    };
  }
  return targetFrameEls;
}

function updateTargetFrame() {
  const els = getTargetFrameEls();
  if (!els) return;
  const { frame, name: nameEl, level: levelEl, hpFill, hpText } = els;

  // Check for enemy target
  if (currentTarget) {
    frame.classList.remove('hidden', 'friendly', 'object');
    frame.classList.add('hostile');

    const targetMax = getMaxHP(currentTarget);
    if (nameEl) nameEl.textContent = currentTarget.name;
    if (levelEl) levelEl.textContent = `Lv.${currentTarget.level}`;
    if (hpFill) hpFill.style.setProperty('--hp-pct', getHPPercent(currentTarget));
    if (hpText) hpText.textContent = `${Math.max(0, currentTarget.hp)}/${targetMax}`;
    return;
  }

  // Check for NPC target
  if (currentNpcTarget) {
    frame.classList.remove('hidden', 'hostile', 'object');
    frame.classList.add('friendly');

    if (nameEl) nameEl.textContent = currentNpcTarget.name;
    
    // NPCs may have level or show role instead
    if (levelEl) {
      if (currentNpcTarget.level) {
        levelEl.textContent = `Lv.${currentNpcTarget.level}`;
      } else if (currentNpcTarget.role) {
        levelEl.textContent = currentNpcTarget.role.charAt(0).toUpperCase() + currentNpcTarget.role.slice(1);
      } else {
        levelEl.textContent = 'NPC';
      }
    }
    
    // NPCs with HP (like guards) show health, others show full bar
    const npcMax = getMaxHP(currentNpcTarget);
    if (currentNpcTarget.hp !== undefined && npcMax) {
      if (hpFill) hpFill.style.setProperty('--hp-pct', getHPPercent(currentNpcTarget));
      if (hpText) hpText.textContent = `${Math.max(0, currentNpcTarget.hp)}/${npcMax}`;
    } else {
      if (hpFill) hpFill.style.setProperty('--hp-pct', 100);
      if (hpText) hpText.textContent = '—';
    }
    return;
  }

  // Check for object target
  if (currentObjectTarget) {
    frame.classList.remove('hidden', 'hostile', 'friendly');
    frame.classList.add('object');

    // Object name from interact label or type
    const objName = currentObjectTarget.interact?.label || 
                    currentObjectTarget.name || 
                    currentObjectTarget.type || 
                    'Object';
    if (nameEl) nameEl.textContent = objName;
    
    // Show interaction type
    if (levelEl) {
      const action = currentObjectTarget.interact?.action;
      if (action === 'collect') levelEl.textContent = 'Collect';
      else if (action === 'read') levelEl.textContent = 'Read';
      else if (action === 'loot') levelEl.textContent = 'Search';
      else levelEl.textContent = 'Interact';
    }
    
    // Objects don't have HP (unless destructible in future)
    if (hpFill) hpFill.style.setProperty('--hp-pct', 100);
    if (hpText) hpText.textContent = '—';
    return;
  }

  // No target
  frame.classList.add('hidden');
  frame.classList.remove('friendly', 'hostile', 'object');
}

function updateActionBar() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;

  // Update weapon toggle slot
  const weaponLabel = document.getElementById('weapon-slot-label');
  const weaponIcon = document.getElementById('weapon-slot-icon');

  if (weaponLabel) weaponLabel.textContent = weapon.name;
  if (weaponIcon) weaponIcon.textContent = weapon.icon || (weapon.type === 'ranged' ? '🔫' : '⚔️');

  // Update weapon ability slots (1-3) based on current weapon
  if (weapon.abilities) {
    [1, 2, 3].forEach(slotNum => {
      const ability = weapon.abilities[slotNum];
      if (ability) {
        const slot = document.querySelector(`.action-slot[data-slot="${slotNum}"][data-action-type="weapon"]`);
        if (slot) {
          const label = slot.querySelector('.slot-label');
          const icon = slot.querySelector('.slot-icon');
          if (label) label.textContent = ability.name;
          if (icon) {
            // Set appropriate icon based on ability
            if (ability.id?.includes('burst')) icon.textContent = '💥';
            else if (ability.id?.includes('suppress')) icon.textContent = '🎯';
            else if (ability.id?.includes('overcharge')) icon.textContent = '⚡';
            else if (ability.id?.includes('cleave')) icon.textContent = '🗡️';
            else if (ability.id?.includes('lunge')) icon.textContent = '🏃';
            else if (ability.id?.includes('shockwave')) icon.textContent = '💫';
          }
          slot.title = `${ability.name}: ${ability.description || ''} (${(ability.cooldownMs / 1000).toFixed(0)}s CD)`;
        }
      }
    });
  }
  
  updateActionBarState();
}

// Update action bar enabled/disabled state based on target
function updateActionBarState() {
  const actionSlots = document.querySelectorAll('.action-slot');
  const actionBar = document.getElementById('action-bar');
  
  // Gray out actions if NPC is targeted (can't attack friendlies)
  const isFriendlyTarget = currentNpcTarget !== null && currentTarget === null;
  
  actionSlots.forEach(slot => {
    if (isFriendlyTarget) {
      slot.classList.add('disabled');
      slot.title = 'Cannot attack friendly NPCs';
    } else {
      slot.classList.remove('disabled');
    }
  });
  
  if (actionBar) {
    if (isFriendlyTarget) {
      actionBar.classList.add('target-friendly');
    } else {
      actionBar.classList.remove('target-friendly');
    }
  }
}

// Cached slot elements for cooldown UI (avoids querySelector every tick)
const cachedSlots = new Map(); // slotNum -> { slot, overlay, timer }

function getCachedSlot(slotNum) {
  if (!cachedSlots.has(slotNum)) {
    const slot = document.querySelector(`.action-slot[data-slot="${slotNum}"][data-action-type="weapon"]`);
    if (slot) {
      cachedSlots.set(slotNum, { slot, overlay: null, timer: null });
    }
  }
  return cachedSlots.get(slotNum);
}

function updateCooldownUI() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;

  // Update weapon ability cooldowns (slots 1-3) using cached elements
  for (const slotNum of [1, 2, 3]) {
    const cached = getCachedSlot(slotNum);
    if (!cached) continue;
    
    const { slot } = cached;
    const cooldown = actionCooldowns[slotNum];
    const maxCooldown = actionMaxCooldowns[slotNum] || 1500;
    const isOnCooldown = cooldown > 0;

    slot.classList.toggle('on-cooldown', isOnCooldown);

    if (isOnCooldown) {
      // Create overlay/timer if needed
      if (!cached.overlay) {
        cached.overlay = document.createElement('div');
        cached.overlay.className = 'cooldown-overlay';
        slot.appendChild(cached.overlay);
      }
      if (!cached.timer) {
        cached.timer = document.createElement('div');
        cached.timer.className = 'cooldown-timer';
        slot.appendChild(cached.timer);
      }

      const pct = (cooldown / maxCooldown) * 100;
      cached.overlay.style.setProperty('--cooldown-pct', pct);
      cached.timer.textContent = (cooldown / 1000).toFixed(1);
    } else if (cached.overlay) {
      // Remove overlay/timer when cooldown ends
      cached.overlay.remove();
      cached.timer?.remove();
      cached.overlay = null;
      cached.timer = null;
    }
  }
  
  // Update swing timer UI
  updateSwingTimerUI();
}

/**
 * Update GCD UI - shows visual lockout on all ability slots
 */
function updateGcdUI() {
  const gcdRemaining = getGcdRemaining();
  const isActive = gcdRemaining > 0;
  
  // Update all weapon ability slots (1-3)
  for (const slotNum of [1, 2, 3]) {
    const slot = document.querySelector(`[data-slot="${slotNum}"][data-action-type="weapon"]`);
    if (slot) {
      slot.classList.toggle('gcd-active', isActive);
    }
  }
  
  // Update sense ability slots (4-5)
  for (const slotNum of [4, 5]) {
    const slot = document.querySelector(`[data-slot="${slotNum}"][data-action-type="sense"]`);
    if (slot) {
      slot.classList.toggle('gcd-active', isActive);
    }
  }
}

// Cache for SVG path length
let swingTimerPathLength = null;
let swingTimerInitialized = false;
// Cumulative offset for continuous loop (only changes on attack)
let swingTimerBaseOffset = 0;

/**
 * Initialize the swing timer SVG (called once)
 */
function initSwingTimer() {
  const fillPath = document.querySelector('#swing-timer-svg .swing-timer-fill');
  if (!fillPath || swingTimerInitialized) return;
  
  swingTimerPathLength = fillPath.getTotalLength();
  // Fixed dasharray: stroke = pathLength, gap = pathLength
  fillPath.style.strokeDasharray = `${swingTimerPathLength} ${swingTimerPathLength}`;
  // Start with full stroke visible (offset = 0)
  fillPath.style.strokeDashoffset = 0;
  swingTimerInitialized = true;
}

/**
 * Start the swing timer animation (called when attack fires)
 * Uses CSS transition for GPU-accelerated animation
 */
function startSwingTimerAnimation() {
  const fillPath = document.querySelector('#swing-timer-svg .swing-timer-fill');
  if (!fillPath || !swingTimerPathLength) return;
  
  const len = swingTimerPathLength;
  
  // Calculate start and end offsets
  // Start: stroke hidden (offset = baseOffset + len)
  // End: stroke visible (offset = baseOffset)
  const startOffset = swingTimerBaseOffset + len;
  const endOffset = swingTimerBaseOffset;
  
  // Shift base for next cycle (continuous loop)
  swingTimerBaseOffset -= len;
  
  // Instantly set to start position (no transition)
  fillPath.style.transition = 'none';
  fillPath.style.strokeDashoffset = startOffset;
  
  // Force reflow to apply instant change
  fillPath.getBoundingClientRect();
  
  // Enable transition and animate to end position
  fillPath.style.transition = `stroke-dashoffset ${BASIC_ATTACK_CD_MS}ms linear`;
  fillPath.style.strokeDashoffset = endOffset;
}

/**
 * Update swing timer visual state classes (called every tick, lightweight)
 */
function updateSwingTimerUI() {
  const weaponSlot = document.getElementById('weapon-toggle-slot');
  if (!weaponSlot) return;
  
  // Initialize if needed
  if (!swingTimerInitialized) {
    initSwingTimer();
  }
  
  const isAutoAttacking = combatIntent?.type === 'basic' && autoAttackEnabled;
  const state = getSwingTimerState();
  
  // Only update classes, not the animation (CSS handles that)
  weaponSlot.classList.toggle('auto-attacking', isAutoAttacking);
  weaponSlot.classList.toggle('swing-cooldown', isAutoAttacking && !state.isReady);
  weaponSlot.classList.toggle('swing-ready', isAutoAttacking && state.isReady);
}

function logCombat(msg) {
  const log = document.getElementById('combat-log');
  if (!log) return;

  const line = document.createElement('div');
  line.className = 'combat-log-line';
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  while (log.children.length > 50) {
    log.removeChild(log.firstChild);
  }
}

// Object pool for damage numbers (avoids DOM churn during combat)
const damageNumberPool = [];
const DAMAGE_POOL_SIZE = 20;
let cachedWorld = null;

function getDamageNumberElement() {
  // Try to get from pool
  const pooled = damageNumberPool.pop();
  if (pooled) return pooled;
  
  // Create new element
  const el = document.createElement('div');
  el.className = 'damage-number';
  return el;
}

function recycleDamageNumber(el) {
  // Reset for reuse
  el.className = 'damage-number';
  el.textContent = '';
  
  // Only pool up to max size
  if (damageNumberPool.length < DAMAGE_POOL_SIZE) {
    damageNumberPool.push(el);
  }
}

function showDamageNumber(x, y, damage, isCrit, isPlayer = false, isBurn = false) {
  if (!cachedWorld) {
    cachedWorld = document.getElementById('world');
  }
  if (!cachedWorld) return;

  const el = getDamageNumberElement();
  
  // Reset animation by removing class, forcing reflow, then re-adding
  el.className = '';
  el.style.animation = 'none';
  void el.offsetHeight; // Force reflow
  el.style.animation = '';
  
  const classes = ['damage-number'];
  if (isCrit) classes.push('crit');
  if (isPlayer) classes.push('player-damage');
  if (isBurn) classes.push('burn-damage');
  el.className = classes.join(' ');
  el.textContent = damage;
  el.style.setProperty('--pos-x', `${x * 24 + 12}px`);
  el.style.setProperty('--pos-y', `${y * 24}px`);

  cachedWorld.appendChild(el);
  
  // Recycle after animation completes
  el.addEventListener('animationend', () => {
    el.remove();
    recycleDamageNumber(el);
  }, { once: true });
}

export function isCombatActive() {
  return inCombat;
}
