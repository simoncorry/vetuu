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
import { hasLineOfSight, canMoveTo } from './collision.js';
import { WEAPONS, ENEMY_WEAPONS } from './weapons.js';
import { 
  distCoords, shuffleArray, applyEffect, tickEffects,
  isSlowed, isVulnerable, getEffectiveMoveSpeed, getVulnMult
} from './utils.js';
import { AI } from './aiConstants.js';
import { getMaxHP, getHPPercent, normalizeHealthKeys, clampHP } from './entityCompat.js';
import { nowMs, toPerfTime, isExpired, remainingMs } from './time.js';
import {
  isImmune, hasSpawnImmunity, isStunned, isRooted, canMove, canAct,
  isBrokenOff, isInSpawnSettle, canAggro,
  getSpawnImmunityRemaining, getSpawnSettleRemaining,
  getLeashRadius, getAggroRadius, computeDeaggroRadius,
  startRetreat, processRetreat, finishResetAtHome,
  shouldBreakOffFromGuards, checkLeashAndDeaggro,
  retreatPack, initEnemyAI, ensureEffects
} from './aiUtils.js';

// Enemy type configurations (Simplified - no weakness/resistance)
// All enemies are either melee (range 2) or ranged (range 6)
const ENEMY_CONFIGS = {
  critter: { weapon: 'melee_claws', aiType: 'melee', hp: 0.7 },
  scav_melee: { weapon: 'melee_club', aiType: 'melee', hp: 0.9 },
  scav_ranged: { weapon: 'ranged_rifle', aiType: 'ranged', hp: 0.8 },
  trog_warrior: { weapon: 'melee_spear', aiType: 'melee', hp: 1.0 },
  trog_shaman: { weapon: 'ranged_bolt', aiType: 'ranged', hp: 0.85 },
  karth_grunt: { weapon: 'karth_laser', aiType: 'ranged', hp: 1.2 },
  karth_officer: { weapon: 'melee_club', aiType: 'melee', hp: 1.3 },
  retriever_captain: { weapon: 'boss_blade', aiType: 'aggressive', hp: 3.0 },
  ironcross_guard: { weapon: 'guard_rifle', aiType: 'guard', hp: 2.0 }
};

// Legacy aliases for backward compatibility
ENEMY_CONFIGS.scav = ENEMY_CONFIGS.scav_ranged;
ENEMY_CONFIGS.scav_pistol = ENEMY_CONFIGS.scav_ranged;
ENEMY_CONFIGS.scav_rifle = ENEMY_CONFIGS.scav_ranged;
ENEMY_CONFIGS.trog_warband = ENEMY_CONFIGS.trog_warrior;

// Timing constants
const DEFAULT_MOVE_COOLDOWN = 400;

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
function typeMult(damageType, defenderConfig) {
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
let meleeAttackQueue = [];
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

// Auto-move state
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

// ============================================
// INITIALIZATION
// ============================================
export function initCombat(state) {
  currentState = state;

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
      maxHp: 100 + GUARD_LEVEL * 10, // Legacy alias
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
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.critter;
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
      showProjectile(enemy.x, enemy.y, guard.x, guard.y, weapon.projectileColor || '#FF4444');
    } else {
      showMeleeSwipe(enemy.x, enemy.y, guard.x, guard.y, weapon.projectileColor || '#FF4444');
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
  const guardEl = document.querySelector(`[data-npc-id="${guard.id}"]`);
  if (guardEl) {
    guardEl.classList.add('dying');
    setTimeout(() => {
      guardEl.classList.remove('dying');
      guardEl.classList.add('downed');
    }, 500);
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
function startCombatTick() {
  if (combatTickInterval) return;

  combatTickInterval = setInterval(() => {
    if (!currentState) return;

    // Use performance.now() for all simulation timing
    const now = nowMs();

    // Update player cooldowns
    for (const key of Object.keys(actionCooldowns)) {
      if (actionCooldowns[key] > 0) actionCooldowns[key] -= 100;
    }
    updateCooldownUI();

    // Try to execute combat intent (handles immunity expiry, movement completion)
    tryExecuteCombatIntent();

    // Process auto-attack
    processAutoAttack();

    // Process regeneration
    processRegeneration(now);

    // Process each active enemy
    for (const enemy of currentState.runtime.activeEnemies) {
      if (enemy.hp <= 0) continue;
      processEnemyAI(enemy, now);
    }

    // Check guard intercepts
    checkGuardIntercept();

    // Tick status effects and update visuals
    tickAllEnemyEffects();

    // Respawning is handled by spawnDirector.js

  }, 100);
}

// ============================================
// AUTO-ATTACK SYSTEM
// ============================================
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
  
  if (actionCooldowns[1] > 0) return;
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;
  
  const player = currentState.player;
  const targetDist = distCoords(player.x, player.y, currentTarget.x, currentTarget.y);
  
  if (targetDist > weapon.range) {
    if (!pendingAttack) {
      moveToAttackRange(currentTarget, weapon.range, 'attack');
    }
    return;
  }
  
  if (!hasLineOfSight(currentState, player.x, player.y, currentTarget.x, currentTarget.y)) {
    return;
  }
  
  executeAttack(weapon);
}

// Get all enemies that are actively engaged with the player
function getEngagedEnemies() {
  if (!currentState?.runtime?.activeEnemies) return [];
  return currentState.runtime.activeEnemies.filter(e => 
    e.hp > 0 && (e.isEngaged || e.state === 'ENGAGED')
  );
}

// Find the next enemy to target - prioritize enemies attacking the player
function findNextCombatTarget() {
  const player = currentState.player;
  const engaged = getEngagedEnemies();
  
  if (engaged.length === 0) return null;
  
  // Sort by distance - closest engaged enemy first
  engaged.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  return engaged[0];
}

// End combat state
function endCombat() {
  inCombat = false;
  autoAttackEnabled = false;
  provokedEnemies.clear(); // Clear provoked enemies when combat ends
  pendingAttack = null;
  logCombat('Combat ended.');
}

function findNearestEnemyInRange() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return null;
  
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
  
  // Fall back to any nearby enemy within weapon range
  const enemies = currentState.runtime.activeEnemies.filter(e => {
    if (e.hp <= 0) return false;
    const d = distCoords(e.x, e.y, player.x, player.y);
    return d <= weapon.range;
  });
  
  if (enemies.length === 0) return null;
  
  enemies.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  return enemies[0];
}

// Find the nearest enemy (any distance) - used when no target and pressing action keys
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
  
  // Fall back to any alive enemy
  const enemies = currentState.runtime.activeEnemies.filter(e => e.hp > 0);
  
  if (enemies.length === 0) return null;
  
  enemies.sort((a, b) => {
    const distA = distCoords(a.x, a.y, player.x, player.y);
    const distB = distCoords(b.x, b.y, player.x, player.y);
    return distA - distB;
  });
  
  return enemies[0];
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
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.critter;
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
    
    // Return home
    const dHome = enemy.home ? distCoords(enemy.x, enemy.y, enemy.home.x, enemy.home.y) : 0;
    if (dHome > 2) {
      moveEnemyTowardHome(enemy, enemy.home.x, enemy.home.y);
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
    
    // Move toward home or idle
    const dHome = enemy.home ? distCoords(enemy.x, enemy.y, enemy.home.x, enemy.home.y) : 0;
    if (dHome > 2) {
      moveEnemyTowardHome(enemy, enemy.home.x, enemy.home.y);
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
  if (!enemy.home) {
    enemy.home = {
      x: enemy.homeCenter?.x ?? enemy.spawnX ?? enemy.x,
      y: enemy.homeCenter?.y ?? enemy.spawnY ?? enemy.y
    };
  }
  
  // Default ranges
  enemy.leashRadius = enemy.leashRadius ?? (enemy.isAlpha ? 18 : AI.DEFAULT_LEASH_RADIUS);
  enemy.aggroRadius = enemy.aggroRadius ?? (enemy.isAlpha ? 12 : AI.DEFAULT_AGGRO_RADIUS);
  
  ensureEffects(enemy);
}

/**
 * Handle unaware state - idle or return home
 */
function handleUnawareState(enemy, t, weapon) {
  enemy.isEngaged = false;
  enemy.state = AI.STATES.UNAWARE;
  
  if (!enemy.home) return;
  
  const dHome = distCoords(enemy.x, enemy.y, enemy.home.x, enemy.home.y);
  
  if (dHome > 2) {
    // Return home and regenerate
    moveEnemyTowardHome(enemy, enemy.home.x, enemy.home.y);
    regenAtHome(enemy, t);
  } else {
    // At home - regenerate and maybe idle
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
 * Handle enemy retreat state - move toward home, heal, and finish when arrived
 */
function handleRetreatState(enemy, t) {
  // Ensure home point exists
  if (!enemy.home) {
    enemy.home = { 
      x: enemy.homeCenter?.x ?? enemy.spawnX ?? enemy.x, 
      y: enemy.homeCenter?.y ?? enemy.spawnY ?? enemy.y 
    };
  }
  
  const distToHome = distCoords(enemy.x, enemy.y, enemy.home.x, enemy.home.y);
  
  // Heal while retreating (15% per second = 1.5% per 100ms tick)
  const retreatMax = getMaxHP(enemy);
  if (retreatMax && enemy.hp < retreatMax) {
    const regenRate = AI.RETREAT_REGEN_RATE;
    const regenAmount = retreatMax * regenRate * 0.1; // ~100ms tick
    enemy.hp = Math.min(retreatMax, enemy.hp + regenAmount);
    updateEnemyHealthBar(enemy);
  }
  
  // Check if arrived home (within 1.5 tiles)
  if (distToHome <= 1.5) {
    finishRetreat(enemy, t);
    return;
  }
  
  // Check if stuck too long - snap to home
  const retreatDur = t - (enemy.retreatStartedAt ?? t);
  if (retreatDur > AI.RETREAT_TIMEOUT_MS) {
    // Snap to home as last resort
    snapEnemyToHome(enemy, t);
    return;
  }
  
  // Move toward home (faster movement during retreat)
  const moveCD = 320; // Faster than normal
  if (!isExpired(enemy.moveCooldown, t)) return;
  
  const dx = Math.sign(enemy.home.x - enemy.x);
  const dy = Math.sign(enemy.home.y - enemy.y);
  
  // Try to move - allow movement even through normal restrictions during retreat
  let moved = false;
  
  // Try diagonal first
  if (dx !== 0 && dy !== 0 && canEnemyMoveToRetreat(enemy.x + dx, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y + dy);
    moved = true;
  } 
  // Try horizontal
  else if (dx !== 0 && canEnemyMoveToRetreat(enemy.x + dx, enemy.y, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y);
    moved = true;
  } 
  // Try vertical
  else if (dy !== 0 && canEnemyMoveToRetreat(enemy.x, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x, enemy.y + dy);
    moved = true;
  }
  
  // If can't move normally, try any adjacent tile closer to home
  if (!moved) {
    const adjacentMoves = [
      { x: enemy.x + 1, y: enemy.y },
      { x: enemy.x - 1, y: enemy.y },
      { x: enemy.x, y: enemy.y + 1 },
      { x: enemy.x, y: enemy.y - 1 },
    ];
    
    // Sort by distance to home
    adjacentMoves.sort((a, b) => {
      const distA = distCoords(a.x, a.y, enemy.home.x, enemy.home.y);
      const distB = distCoords(b.x, b.y, enemy.home.x, enemy.home.y);
      return distA - distB;
    });
    
    for (const pos of adjacentMoves) {
      if (canEnemyMoveToRetreat(pos.x, pos.y, enemy.id)) {
        updateEnemyPosition(enemy, pos.x, pos.y);
        moved = true;
        break;
      }
    }
  }
  
  // Track if stuck
  if (!moved) {
    enemy.retreatStuckSince = enemy.retreatStuckSince ?? t;
    // If stuck for 2 seconds, snap
    if (t - enemy.retreatStuckSince > 2000) {
      snapEnemyToHome(enemy, t);
      return;
    }
  } else {
    enemy.retreatStuckSince = null;
  }
  
  enemy.moveCooldown = t + moveCD;
  
  // Update visual to show retreating state
  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (el && !el.classList.contains('retreating')) {
    el.classList.add('retreating');
  }
}

/**
 * Movement check for retreating enemies - more lenient
 */
function canEnemyMoveToRetreat(x, y, enemyId) {
  // Basic walkability check
  if (!canMoveTo(currentState, x, y)) return false;
  
  // Don't collide with other enemies
  for (const other of currentState.runtime.activeEnemies || []) {
    if (other.id === enemyId || other.hp <= 0) continue;
    if (other.x === x && other.y === y) return false;
  }
  
  // Don't collide with player
  const player = currentState.player;
  if (player.x === x && player.y === y) return false;
  
  return true;
}

/**
 * Snap enemy to home position (used when stuck)
 */
function snapEnemyToHome(enemy, t) {
  // Update position in data
  enemy.x = enemy.home.x;
  enemy.y = enemy.home.y;
  
  // Update DOM element position immediately
  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (el) {
    // Disable transition for instant snap
    el.style.transition = 'none';
    el.style.transform = `translate3d(${enemy.x * 24}px, ${enemy.y * 24}px, 0)`;
    // Force reflow
    el.offsetHeight;
    // Re-enable transition
    el.style.transition = '';
  }
  
  finishRetreat(enemy, t);
}

/**
 * Finish retreat - enemy has arrived home
 */
function finishRetreat(enemy, t) {
  enemy.isRetreating = false;
  enemy.state = AI.STATES.UNAWARE;
  enemy.retreatReason = null;
  enemy.retreatStartedAt = null;
  enemy.retreatStuckSince = null;
  
  // Clear combat state
  enemy.targetId = null;
  enemy.isEngaged = false;
  enemy.isAware = false;
  
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
  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
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
 * Move enemy toward home point (legacy wrapper)
 */
function moveEnemyTowardHome(enemy, targetX, targetY) {
  const t = nowMs();
  
  // Movement cooldown
  const moveCD = 400 * (enemy.isRetreating ? 0.8 : 1);
  if (!isExpired(enemy.moveCooldown, t)) return;
  
  const dx = Math.sign(targetX - enemy.x);
  const dy = Math.sign(targetY - enemy.y);
  
  // Try direct path first
  if (dx !== 0 && dy !== 0 && canEnemyMoveTo(enemy.x + dx, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y + dy);
  } else if (dx !== 0 && canEnemyMoveTo(enemy.x + dx, enemy.y, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y);
  } else if (dy !== 0 && canEnemyMoveTo(enemy.x, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x, enemy.y + dy);
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
 */
function updateEnemyVisuals() {
  if (!currentState?.runtime?.activeEnemies) return;
  
  const t = nowMs();
  
  for (const enemy of currentState.runtime.activeEnemies) {
    if (enemy.hp <= 0) continue;
    
    const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
    if (!el) continue;
    
    // Retreating visual
    if (enemy.isRetreating) {
      el.classList.add('retreating');
    } else {
      el.classList.remove('retreating');
    }
    
    // Spawn immunity visual
    const immuneRemaining = getSpawnImmunityRemaining(enemy, t);
    if (immuneRemaining > 0) {
      el.classList.add('spawn-immune');
    } else {
      el.classList.remove('spawn-immune');
    }
    
    // Passive state visual - CSS handles the color via .passive class
    const isPassive = isEnemyPassive(enemy) && !provokedEnemies.has(enemy.id);
    if (isPassive) {
      el.classList.add('passive');
      el.dataset.passive = 'true';
    } else {
      el.classList.remove('passive');
      delete el.dataset.passive;
    }
    
    // In-combat visual (flashing red glow) - when enemy is actively engaged/provoked
    const isInCombat = enemy.isEngaged || enemy.isAware || provokedEnemies.has(enemy.id);
    if (isInCombat && !enemy.isRetreating) {
      el.classList.add('in-combat');
    } else {
      el.classList.remove('in-combat');
    }
    
    // Update badge if present
    const badge = el.querySelector('.enemy-level-badge');
    if (badge) {
      if (isPassive) {
        badge.classList.add('passive-badge');
      } else {
        badge.classList.remove('passive-badge');
      }
    }
  }
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
  
  // Don't wander too far from spawn point
  if (enemy.spawnX !== undefined && enemy.spawnY !== undefined) {
    const distFromSpawn = distCoords(newX, newY, enemy.spawnX, enemy.spawnY);
    if (distFromSpawn > 4) {
      // Move back toward spawn instead
      const toSpawnX = Math.sign(enemy.spawnX - enemy.x);
      const toSpawnY = Math.sign(enemy.spawnY - enemy.y);
      if (canEnemyMoveTo(enemy.x + toSpawnX, enemy.y + toSpawnY, enemy)) {
        updateEnemyPosition(enemy, enemy.x + toSpawnX, enemy.y + toSpawnY);
      }
      enemy.moveCooldown = now + moveCD;
      return;
    }
  }
  
  if (canEnemyMoveTo(newX, newY, enemy)) {
    updateEnemyPosition(enemy, newX, newY);
  }
  
  enemy.moveCooldown = now + moveCD;
}

// Check if an enemy is passive (yellow critter)
function isEnemyPassive(enemy) {
  // New system: check aggroType from spawn director
  if (enemy.aggroType === 'passive') return true;
  if (enemy.aggroType === 'aggressive') return false;
  if (enemy.aggroType === 'conditional') {
    // Conditional becomes aggressive in Act 3 or when provoked
    const isAct3 = currentState?.flags?.act3;
    if (isAct3) return false;
  }
  
  // Legacy fallback: critters under level 5 are passive
  return enemy.type === 'critter' && enemy.level < PASSIVE_CRITTER_MAX_LEVEL;
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
  
  // Aggro the entire pack
  aggroPack(enemy, t);
  
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
  
  // Find an unoccupied position
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
      
      for (const move of moves) {
        if (canEnemyMoveTo(move.x, move.y, enemy.id)) {
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
        
        for (const move of moves) {
          if (canEnemyMoveTo(move.x, move.y, enemy.id)) {
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
  
  // If player is too close, retreat (always try to escape melee)
  if (dist <= 2 && isExpired(enemy.moveCooldown, t)) {
        moveAwayFromPlayer(enemy);
    enemy.moveCooldown = t + moveCD;
    return;
  }
  
  // In range with LOS - check if we can engage (max 2 attackers)
  if (dist <= weapon.range && hasLOS) {
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
  
  // Out of range with LOS - advance cautiously
  if (isExpired(enemy.moveCooldown, t) && Math.random() < 0.6) {
      moveTowardPlayerRanged(enemy, weapon.range);
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

  for (const move of moves) {
    if (canEnemyMoveTo(move.x, move.y, enemy.id)) {
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

    for (const move of moves) {
      const newDist = distCoords(move.x, move.y, player.x, player.y);
    if (newDist >= preferredDist - 1 && canEnemyMoveTo(move.x, move.y, enemy.id)) {
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

  for (const move of moves) {
    if (canEnemyMoveTo(move.x, move.y, enemy.id)) {
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

function updateEnemyPosition(enemy, x, y, forceMove = false) {
  // Rooted enemies can't move (unless retreating or forced)
  if (!forceMove && !enemy.isRetreating && isRooted(enemy)) {
    return;
  }
  
  enemy.x = x;
  enemy.y = y;

  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (el) {
    el.style.transform = `translate3d(${x * 24}px, ${y * 24}px, 0)`;
  }
}

// Get enemy's effective move cooldown (factoring in slow)
function getEnemyMoveCooldown(enemy, baseMoveCD) {
  return getEffectiveMoveSpeed(enemy, baseMoveCD);
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
    showProjectile(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || '#FF4444');
  } else {
    showMeleeSwipe(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || '#FF4444');
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
// PLAYER ATTACK
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
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;

  if (actionCooldowns[1] > 0) return;

  if (!currentTarget || currentTarget.hp <= 0) {
    logCombat('No target selected. Press Tab to target.');
    return;
  }

  const player = currentState.player;
  const dist = distCoords(player.x, player.y, currentTarget.x, currentTarget.y);

  if (dist > weapon.range) {
    moveToAttackRange(currentTarget, weapon.range, 'attack');
    return;
  }

  if (!hasLineOfSight(currentState, player.x, player.y, currentTarget.x, currentTarget.y)) {
    logCombat('No line of sight!');
    return;
  }

  executeAttack(weapon);
}

function executeAttack(weapon) {
  if (!currentTarget || currentTarget.hp <= 0) return;
  if (!weapon) return;

  // Check spawn immunity (spawn camping prevention)
  if (hasSpawnImmunity(currentTarget)) {
    logCombat('Enemy is still materializing...');
    return;
  }

  // Provoke the target if it's passive
  provokeEnemy(currentTarget);

  const player = currentState.player;
  let damage = calculateDamage(weapon, currentTarget);

  if (weapon.type === 'ranged') {
    showProjectile(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || '#00FFFF');
  } else {
    showMeleeSwipe(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || '#00FFFF');
  }

  currentTarget.hp -= damage;
  markCombatEvent(); // Track combat activity for regen gating
  
  // Use crit flag from calculateDamage instead of heuristic
  const isCrit = !!weapon.__lastCrit;
  weapon.__lastCrit = false;
  showDamageNumber(currentTarget.x, currentTarget.y, damage, isCrit);
  logCombat(`${damage} damage with ${weapon.name || 'attack'}`);

  updateEnemyHealthBar(currentTarget);
  updateTargetFrame();

  // Set cooldown from first action or default
  const cooldown = weapon.actions?.[0]?.cooldown || 1500;
  actionCooldowns[1] = cooldown;
  actionMaxCooldowns[1] = cooldown;

  if (currentTarget.hp <= 0) {
    handleEnemyDeath(currentTarget);
  }
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

export function checkPendingAttack() {
  if (!pendingAttack) {
    return;
  }
  
  // Target died or became invalid
  if (!currentTarget || currentTarget.hp <= 0) {
    pendingAttack = null;
    return;
  }

  const player = currentState.player;
  const targetDist = distCoords(player.x, player.y, pendingAttack.target.x, pendingAttack.target.y);
  
  if (targetDist <= pendingAttack.range) {
    const weapon = WEAPONS[currentWeapon];
    if (!weapon) {
      pendingAttack = null;
      return;
    }
    
    if (hasLineOfSight(currentState, player.x, player.y, pendingAttack.target.x, pendingAttack.target.y)) {
      const actionKey = pendingAttack.actionType;
      const keyNum = parseInt(actionKey);
      
      // Handle basic attack (actionType === 'attack')
      if (actionKey === 'attack') {
        if (actionCooldowns[1] <= 0) {
          pendingAttack = null;
        executeAttack(weapon);
      }
    }
      // Handle numbered action keys (1, 2, 3)
      else if (!isNaN(keyNum) && keyNum >= 1 && keyNum <= 3) {
        if (actionCooldowns[keyNum] <= 0) {
          pendingAttack = null; // Clear first to prevent recursion
          useAction(keyNum);
        }
      } else {
    pendingAttack = null;
      }
    } else {
      // No LOS - will need to keep moving
    }
  }
}

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
    showProjectile(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || '#00FFFF', true);
  } else {
    showMeleeSwipe(player.x, player.y, currentTarget.x, currentTarget.y, weapon.projectileColor || '#FFD700', true);
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
  showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || '#00FFFF');
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
    showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || '#00FFFF');
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
      showProjectile(player.x, player.y, target.x, target.y, weapon.projectileColor || '#00FFFF');
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
      
      // Update visual position
      const playerEl = document.getElementById('player');
      if (playerEl) {
        playerEl.style.transform = `translate3d(${newX * 24}px, ${newY * 24}px, 0)`;
      }
      
      // Update camera
      import('./game.js').then(({ updateCamera }) => {
        if (typeof updateCamera === 'function') updateCamera(currentState);
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
  if (currentWeapon === 'rifle') {
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
function showProjectile(fromX, fromY, toX, toY, color, isEnhanced = false) {
  const world = document.getElementById('world');
  if (!world) return;

  const projectile = document.createElement('div');
  projectile.className = `projectile ${isEnhanced ? 'enhanced' : ''}`;
  projectile.style.setProperty('--color', color);
  projectile.style.left = `${fromX * 24 + 12}px`;
  projectile.style.top = `${fromY * 24 + 12}px`;

  const dx = (toX - fromX) * 24;
  const dy = (toY - fromY) * 24;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  projectile.style.setProperty('--dx', `${dx}px`);
  projectile.style.setProperty('--dy', `${dy}px`);
  projectile.style.transform = `rotate3d(0, 0, 1, ${angle}deg)`;

  world.appendChild(projectile);
  setTimeout(() => projectile.remove(), 300);
}

function showMeleeSwipe(fromX, fromY, toX, toY, color, isEnhanced = false) {
  const world = document.getElementById('world');
  if (!world) return;

  const swipe = document.createElement('div');
  swipe.className = `melee-swipe ${isEnhanced ? 'enhanced' : ''}`;
  swipe.style.setProperty('--color', color);
  swipe.style.left = `${toX * 24}px`;
  swipe.style.top = `${toY * 24}px`;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  swipe.style.setProperty('--angle', `${angle}deg`);

  world.appendChild(swipe);
  setTimeout(() => swipe.remove(), 300);
}

function showCleaveEffect(x, y) {
  const world = document.getElementById('world');
  if (!world) return;

  const cleave = document.createElement('div');
  cleave.className = 'cleave-effect';
  cleave.style.left = `${x * 24 - 24}px`;
  cleave.style.top = `${y * 24 - 24}px`;

  world.appendChild(cleave);
  setTimeout(() => cleave.remove(), 400);
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

// ============================================
// COMBAT INTENT SYSTEM
// ============================================
// Persistent engagement: right-click commits to fighting until success/cancel
const INTENT_TIMEOUT_MS = 10000; // 10s - clear intent if no successful attack
let combatIntent = null; // { type:'autoAttack', targetId, createdAt, retryAt, lastSuccessAt }

/**
 * Set auto-attack intent on a target.
 * Intent persists until target dies, player cancels, or target becomes permanently invalid.
 */
function setAutoAttackIntent(target) {
  if (!target || target.hp <= 0) return;
  combatIntent = {
    type: 'autoAttack',
    targetId: target.id,
    createdAt: nowMs(),
    retryAt: 0,
    lastSuccessAt: 0
  };
}

/**
 * Clear combat intent.
 */
function clearCombatIntent() {
  combatIntent = null;
}

/**
 * Get the target from current intent (resolves by id).
 */
function getIntentTarget() {
  if (!combatIntent || !currentState?.runtime?.activeEnemies) return null;
  return currentState.runtime.activeEnemies.find(e => e.id === combatIntent.targetId);
}

/**
 * Try to execute combat intent.
 * Called: after movement completes, in combat tick, on intent creation.
 * 
 * Rules:
 * - Resolve target by id
 * - Reselect if target changed/cleared
 * - If immune: set retryAt and return (no log spam)
 * - If out of range/LOS: moveToAttackRange and return
 * - Else: playerAttack()
 */
export function tryExecuteCombatIntent() {
  if (!combatIntent || combatIntent.type !== 'autoAttack') return;
  
  const now = nowMs();
  
  // Timeout check - clear intent if no successful attack for INTENT_TIMEOUT_MS
  const sinceSuccess = combatIntent.lastSuccessAt ? (now - combatIntent.lastSuccessAt) : (now - combatIntent.createdAt);
  if (sinceSuccess > INTENT_TIMEOUT_MS) {
    logCombat('Lost target.');
    clearCombatIntent();
    return;
  }
  
  // Throttle retries (prevent spam when immune)
  if (combatIntent.retryAt && now < combatIntent.retryAt) return;
  
  const target = getIntentTarget();
  
  // Target invalid - clear intent
  if (!target || target.hp <= 0) {
    clearCombatIntent();
    return;
  }
  
  // Ensure target is selected
  if (currentTarget?.id !== target.id) {
    selectTarget(target);
  }
  
  // Check spawn immunity - schedule retry
  if (hasSpawnImmunity(target)) {
    combatIntent.retryAt = now + 200; // Check again in 200ms
    return;
  }
  
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;
  
  const player = currentState.player;
  const dist = distCoords(player.x, player.y, target.x, target.y);
  
  // Out of range - move to attack range
  if (dist > weapon.range) {
    if (!pendingAttack) {
      moveToAttackRange(target, weapon.range, 'attack');
    }
    return;
  }
  
  // No LOS - move to attack range
  if (!hasLineOfSight(currentState, player.x, player.y, target.x, target.y)) {
    if (!pendingAttack) {
      moveToAttackRange(target, weapon.range, 'attack');
    }
    return;
  }
  
  // Ready to attack
  if (actionCooldowns[1] <= 0) {
    playerAttack();
    // Mark successful attack for timeout tracking
    if (combatIntent) {
      combatIntent.lastSuccessAt = now;
    }
  }
}

// Debug helpers
if (typeof window !== 'undefined') {
  window.VETUU_INTENT = () => combatIntent;
  
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
}

// ============================================
// TARGETING
// ============================================
export function handleTargeting(action, data) {
  switch (action) {
    case 'cycle': cycleTarget(); break;
    case 'select': selectTarget(data); break;
    case 'selectNpc': selectNpcTarget(data); break;
    case 'clear': clearTarget(); break;
    case 'attack': 
      // If enemy data provided, select it first then start auto-attack
      if (data && data.hp > 0) {
        selectTarget(data);
      }
      if (currentTarget) {
        autoAttackEnabled = true;
        inCombat = true;
        // Set persistent combat intent and try to execute
        setAutoAttackIntent(currentTarget);
        tryExecuteCombatIntent();
      }
      break;
    case 'special': playerSpecial(); break;
    case 'cycleWeapon': cycleWeapon(); break;
    case 'action': useAction(data); break;
  }
}

function cycleTarget() {
  const enemies = currentState.runtime.activeEnemies.filter(e => e.hp > 0);
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
    const prevEl = document.querySelector(`[data-npc-id="${currentNpcTarget.id}"]`);
    if (prevEl) prevEl.classList.remove('targeted');
  }

  currentNpcTarget = npc;

  const el = document.querySelector(`[data-npc-id="${npc.id}"]`);
  if (el) el.classList.add('targeted');

  updateTargetFrame();
  updateActionBarState();
}

function clearNpcTarget() {
  if (currentNpcTarget) {
    const el = document.querySelector(`[data-npc-id="${currentNpcTarget.id}"]`);
    if (el) el.classList.remove('targeted');
  }
  currentNpcTarget = null;
}

function clearTarget() {
  if (currentTarget) {
    const el = document.querySelector(`[data-enemy-id="${currentTarget.id}"]`);
    if (el) el.classList.remove('targeted');
  }
  currentTarget = null;
  
  // Clear combat intent when target is cleared
  clearCombatIntent();
  
  // Don't end combat here - let processAutoAttack handle combat state
  // It will check for engaged/provoked enemies and end combat when appropriate
  
  clearNpcTarget();
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
    maxHp: calculateEnemyHP(bossDef.level) * 3, // Legacy alias
    atk: calculateEnemyAtk(bossDef.level) * 1.5,
    def: calculateEnemyDef(bossDef.level),
    cooldownUntil: 0,
    moveCooldown: 0,
    isBoss: true,
    color: '#8B45D6'
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

function getEnemyColor(type) {
  const colors = {
    critter: '#6B5B4F',
    scav: '#8B6B4F',
    trog_warband: '#8B5A2B',
    karth_grunt: '#2E343B',
    retriever_captain: '#8B45D6',
    ironcross_guard: '#22B6B8'
  };
  return colors[type] || '#D64545';
}

// ============================================
// DEATH HANDLING
// ============================================
async function handleEnemyDeath(enemy) {
  logCombat(`${enemy.name} defeated!`);

  // Remove from provoked set and attacker slots
  provokedEnemies.delete(enemy.id);
  releaseAttackerSlot(enemy);

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
    setTimeout(() => el.remove(), 500);
  }

  if (currentTarget?.id === enemy.id) {
    // Target died - find next engaged enemy if in combat
    currentTarget = null;
    
    if (inCombat && autoAttackEnabled) {
      const nextTarget = findNextCombatTarget();
      if (nextTarget) {
        selectTarget(nextTarget);
      }
    }
    
    updateTargetFrame();
    updateActionBarState();
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
    playerEl.style.transform = `translate3d(${spawnX * 24}px, ${spawnY * 24}px, 0)`;
    playerEl.offsetHeight; // Force reflow
    playerEl.style.transition = '';
  }

  // Update camera and fog for new position
  updateCamera(currentState);
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
    playerEl.style.transform = `translate3d(${spawnX * 24}px, ${spawnY * 24}px, 0)`;
    playerEl.offsetHeight;
    playerEl.style.transition = '';
    }

    updateCamera(currentState);
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
    playerEl.style.transform = `translate3d(${corpseLocation.x * 24}px, ${corpseLocation.y * 24}px, 0)`;
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

  updateCamera(currentState);
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
export function renderEnemies(state) {
  const actorLayer = document.getElementById('actor-layer');
  if (!actorLayer) return;

  actorLayer.querySelectorAll('.enemy').forEach(el => el.remove());

  const playerLevel = state.player.level;

  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;

    const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.critter;
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
    el.style.setProperty('--enemy-color', enemy.color);
    el.style.setProperty('--enemy-move-speed', `${moveSpeed}ms`);
    
    // Initial position without transition
    el.style.transition = 'none';
    el.style.transform = `translate3d(${enemy.x * 24}px, ${enemy.y * 24}px, 0)`;
    
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

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectTarget(enemy);
    });

    if (currentTarget?.id === enemy.id) {
      el.classList.add('targeted');
    }

    actorLayer.appendChild(el);
  }
  
  // Re-enable transitions after initial placement (CSS uses --enemy-move-speed variable)
  requestAnimationFrame(() => {
    actorLayer.querySelectorAll('.enemy').forEach(el => {
      el.style.transition = '';
    });
  });
}

// Note: updateEnemyVisuals() is defined earlier in the file with comprehensive logic

function updateEnemyHealthBar(enemy) {
  const fill = document.querySelector(`[data-enemy-id="${enemy.id}"] .enemy-hp-fill`);
  if (fill) {
    fill.style.setProperty('--hp-pct', getHPPercent(enemy));
  }
}

// Update enemy element with current status effect classes
function updateEnemyStatusEffects(enemy) {
  const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
  if (!el) return;
  
  // Toggle status effect classes
  el.classList.toggle('is-stunned', isStunned(enemy));
  el.classList.toggle('is-rooted', isRooted(enemy));
  el.classList.toggle('is-slowed', isSlowed(enemy));
  el.classList.toggle('is-vulnerable', isVulnerable(enemy));
  el.classList.toggle('is-immune', isImmune(enemy));
}

// Tick all enemy effects and update visuals
function tickAllEnemyEffects() {
  const t = nowMs();
  
  for (const enemy of currentState.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;
    
    // Tick status effects
    tickEffects(enemy);
    updateEnemyStatusEffects(enemy);
    
    // Sync spawn immunity visual state
    const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
    if (el) {
      const immuneRemaining = getSpawnImmunityRemaining(enemy, t);
      if (immuneRemaining > 0) {
        el.classList.add('spawn-immune');
      } else {
        el.classList.remove('spawn-immune');
      }
      
      // Sync retreating visual
      if (enemy.isRetreating) {
        el.classList.add('retreating');
      } else {
        el.classList.remove('retreating');
      }
    }
  }
}

// ============================================
// UI UPDATES
// ============================================
function updatePlayerHealthBar() {
  const player = currentState.player;
  const max = getMaxHP(player);
  const pct = getHPPercent(player);
  
  const fill = document.getElementById('player-hp-fill');
  const text = document.getElementById('player-hp-text');
  if (fill) fill.style.setProperty('--hp-pct', pct);
  if (text) text.textContent = `${player.hp}/${max}`;

  const mainFill = document.getElementById('hp-fill');
  const mainText = document.getElementById('hp-text');
  if (mainFill) mainFill.style.setProperty('--pct', pct);
  if (mainText) mainText.textContent = `${player.hp}/${max}`;
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

function updateTargetFrame() {
  const frame = document.getElementById('target-frame');
  if (!frame) return;

  // Check for enemy target
  if (currentTarget) {
  frame.classList.remove('hidden');
    frame.classList.remove('friendly');
    frame.classList.add('hostile');

  const nameEl = frame.querySelector('.frame-name');
  const levelEl = frame.querySelector('.frame-level');
  const hpFill = frame.querySelector('.frame-hp-fill');
  const hpText = frame.querySelector('.frame-hp-text');

  const targetMax = getMaxHP(currentTarget);
  if (nameEl) nameEl.textContent = currentTarget.name;
  if (levelEl) levelEl.textContent = `Lv.${currentTarget.level}`;
  if (hpFill) hpFill.style.setProperty('--hp-pct', getHPPercent(currentTarget));
  if (hpText) hpText.textContent = `${Math.max(0, currentTarget.hp)}/${targetMax}`;
    return;
  }

  // Check for NPC target
  if (currentNpcTarget) {
    frame.classList.remove('hidden');
    frame.classList.remove('hostile');
    frame.classList.add('friendly');

    const nameEl = frame.querySelector('.frame-name');
    const levelEl = frame.querySelector('.frame-level');
    const hpFill = frame.querySelector('.frame-hp-fill');
    const hpText = frame.querySelector('.frame-hp-text');

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

  // No target
  frame.classList.add('hidden');
  frame.classList.remove('friendly', 'hostile');
}

function updateActionBar() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;

  const weaponName = document.getElementById('current-weapon-name');
  const weaponIcon = document.getElementById('current-weapon-icon');

  if (weaponName) weaponName.textContent = weapon.name;
  if (weaponIcon) weaponIcon.textContent = weapon.icon;

  if (weapon.actions) {
    weapon.actions.forEach((action, index) => {
      const slot = document.querySelector(`.action-slot[data-action-key="${index + 1}"]`);
      if (slot) {
        const label = slot.querySelector('.slot-label');
        if (label) label.textContent = action.name;
        slot.title = `${action.name} (${(action.cooldown / 1000).toFixed(1)}s cooldown)`;
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

function updateCooldownUI() {
  const weapon = WEAPONS[currentWeapon];
  if (!weapon) return;

  for (const key of ['1', '2', '3']) {
    const slot = document.querySelector(`.action-slot[data-action-key="${key}"]`);
    if (!slot) continue;

    const cooldown = actionCooldowns[key];
    const maxCooldown = actionMaxCooldowns[key] || 1500;
    const isOnCooldown = cooldown > 0;

    slot.classList.toggle('on-cooldown', isOnCooldown);

    let overlay = slot.querySelector('.cooldown-overlay');
    let timer = slot.querySelector('.cooldown-timer');

    if (isOnCooldown) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'cooldown-overlay';
        slot.appendChild(overlay);
      }
      if (!timer) {
        timer = document.createElement('div');
        timer.className = 'cooldown-timer';
        slot.appendChild(timer);
      }

      const pct = (cooldown / maxCooldown) * 100;
      overlay.style.setProperty('--cooldown-pct', pct);
      timer.textContent = (cooldown / 1000).toFixed(1);
    } else {
      overlay?.remove();
      timer?.remove();
    }
  }
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

function showDamageNumber(x, y, damage, isCrit, isPlayer = false) {
  const world = document.getElementById('world');
  if (!world) return;

  const el = document.createElement('div');
  el.className = `damage-number ${isCrit ? 'crit' : ''} ${isPlayer ? 'player-damage' : ''}`;
  el.textContent = damage;
  el.style.left = `${x * 24 + 12}px`;
  el.style.top = `${y * 24}px`;

  world.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

export function isCombatActive() {
  return inCombat;
}
