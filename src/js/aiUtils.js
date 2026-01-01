/**
 * VETUU — AI Utilities
 * Helper functions for enemy AI behavior, retreat, and state management.
 * 
 * TIMING: All functions use performance.now() via time.js for consistency.
 * Legacy Date.now() timestamps are normalized via toPerfTime().
 */

import { AI } from './aiConstants.js';
import { nowMs, toPerfTime, isExpired, remainingMs } from './time.js';

// Re-export nowMs for convenience
export { nowMs, toPerfTime, isExpired, remainingMs };

// ============================================
// DISTANCE
// ============================================

/** Euclidean distance between two points */
export function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Distance between two entities with x,y properties */
export function distEntities(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ============================================
// EFFECTS MANAGEMENT
// ============================================

/** Ensure entity has effects object with all fields initialized */
export function ensureEffects(entity) {
  if (!entity.effects) entity.effects = {};
  entity.effects.stunUntil ??= 0;
  entity.effects.rootUntil ??= 0;
  entity.effects.slowUntil ??= 0;
  entity.effects.slowMult ??= 1;
  entity.effects.vulnUntil ??= 0;
  entity.effects.vulnMult ??= 1;
  entity.effects.immuneUntil ??= 0;
}

// ============================================
// STATUS CHECKS
// ============================================

/**
 * Check if entity is immune to damage/CC.
 * Spawn immunity blocks damage/CC only, NOT detection/aggro.
 */
export function isImmune(entity, t = nowMs()) {
  // Player immunity flag (corpse run immunity)
  if (entity.isImmune === true) return true;
  
  // Effects-based immunity
  if (!isExpired(entity.effects?.immuneUntil, t)) return true;
  
  // Spawn immunity (normalized from legacy Date.now timestamps)
  if (!isExpired(entity.spawnImmunityUntil, t)) return true;
  
  return false;
}

/**
 * Check if entity has spawn immunity.
 * Used to block damage/CC, but NOT aggro/detection.
 */
export function hasSpawnImmunity(entity, t = nowMs()) {
  return !isExpired(entity.spawnImmunityUntil, t);
}

/**
 * Get remaining spawn immunity time in ms.
 */
export function getSpawnImmunityRemaining(entity, t = nowMs()) {
  return remainingMs(entity.spawnImmunityUntil, t);
}

/** Check if entity is stunned */
export function isStunned(entity, t = nowMs()) {
  return !isExpired(entity.effects?.stunUntil, t);
}

/** Check if entity is rooted */
export function isRooted(entity, t = nowMs()) {
  return !isExpired(entity.effects?.rootUntil, t);
}

/** Check if entity is slowed */
export function isSlowed(entity, t = nowMs()) {
  return !isExpired(entity.effects?.slowUntil, t);
}

/** Check if entity can move (not stunned or rooted) */
export function canMove(entity, t = nowMs()) {
  return !isStunned(entity, t) && !isRooted(entity, t);
}

/** Check if entity can act (not stunned) */
export function canAct(entity, t = nowMs()) {
  return !isStunned(entity, t);
}

/**
 * Check if entity is broken off (cannot re-aggro yet).
 * Uses normalized time comparison.
 */
export function isBrokenOff(entity, t = nowMs()) {
  return !isExpired(entity.brokenOffUntil, t);
}

/**
 * Check if entity is in spawn settle period.
 * Spawn settle: cannot ATTACK yet, but CAN aggro/detect.
 * This prevents instant attacks right after spawn, but allows immediate engagement.
 */
export function isInSpawnSettle(entity, t = nowMs()) {
  const spawnTime = toPerfTime(entity.spawnedAt ?? 0);
  if (!spawnTime) return false;
  return t < spawnTime + AI.SPAWN_SETTLE_MS;
}

/**
 * Get remaining spawn settle time in ms.
 */
export function getSpawnSettleRemaining(entity, t = nowMs()) {
  const spawnTime = toPerfTime(entity.spawnedAt ?? 0);
  if (!spawnTime) return 0;
  return Math.max(0, (spawnTime + AI.SPAWN_SETTLE_MS) - t);
}

/**
 * Check if entity can aggro (not broken off, not retreating).
 * NOTE: Spawn immunity/settle do NOT block aggro.
 */
export function canAggro(entity, t = nowMs()) {
  if (entity.isRetreating) return false;
  if (isBrokenOff(entity, t)) return false;
  return true;
}

// ============================================
// RADIUS CALCULATIONS
// ============================================

/** Compute deaggro radius with hysteresis */
export function computeDeaggroRadius(enemy) {
  const aggroRadius = enemy.aggroRadius ?? AI.DEFAULT_AGGRO_RADIUS;
  return enemy.deaggroRadius ?? (aggroRadius + AI.DEFAULT_DEAGGRO_RADIUS_PAD);
}

/** Get enemy's leash radius */
export function getLeashRadius(enemy) {
  return enemy.leashRadius ?? AI.DEFAULT_LEASH_RADIUS;
}

/** Get enemy's aggro radius */
export function getAggroRadius(enemy) {
  return enemy.aggroRadius ?? AI.DEFAULT_AGGRO_RADIUS;
}

// ============================================
// RETREAT SYSTEM
// ============================================

/**
 * Start retreat for an enemy
 * @param {object} enemy - The enemy to retreat
 * @param {number} t - Current time in ms
 * @param {string} reason - Why retreating: 'leash', 'guards', 'lost', 'pack'
 */
export function startRetreat(enemy, t = nowMs(), reason = 'leash') {
  // Already retreating? Just update reason if more urgent
  if (enemy.isRetreating) {
    if (reason === 'guards') {
      enemy.retreatReason = reason;
    }
    return;
  }

  enemy.isRetreating = true;
  enemy.retreatReason = reason;
  enemy.state = AI.STATES.RETREATING;

  // Clear target and combat intent
  enemy.targetId = null;
  enemy.isEngaged = false;
  enemy.isAware = false;

  // Prevent instant re-aggro loops
  // Guards get extra time to prevent pinball
  const extraTime = (reason === 'guards') ? AI.GUARD_BREAKOFF_EXTRA_MS : 0;
  enemy.brokenOffUntil = Math.max(enemy.brokenOffUntil ?? 0, t + AI.BROKEN_OFF_MS + extraTime);

  // Reset disengage timer
  enemy.outOfRangeSince = null;

  // Stop attacking immediately
  enemy.nextAttackAt = Math.max(enemy.nextAttackAt ?? 0, t + 250);

  // Retreat bookkeeping
  enemy.retreatStartedAt = t;
  enemy.retreatStuckSince = null;
}

/**
 * Process retreat movement and healing
 * @returns {boolean} True if still retreating, false if finished
 */
export function processRetreat(enemy, moveTowardFn, t = nowMs(), dtMs = 100) {
  if (!enemy.isRetreating) return false;

  // Heal while retreating
  regenWhileRetreating(enemy, dtMs);

  // Ensure home point exists
  if (!enemy.home) {
    enemy.home = { x: enemy.spawnX ?? enemy.x, y: enemy.spawnY ?? enemy.y };
  }

  // Check if stuck too long
  const retreatDur = t - (enemy.retreatStartedAt ?? t);
  if (retreatDur > AI.RETREAT_TIMEOUT_MS) {
    // Snap to home as last resort
    enemy.x = enemy.home.x;
    enemy.y = enemy.home.y;
    finishResetAtHome(enemy, t);
    return false;
  }

  // Check if arrived home
  const distToHome = dist(enemy.x, enemy.y, enemy.home.x, enemy.home.y);
  if (distToHome <= AI.HOME_ARRIVE_EPS) {
    finishResetAtHome(enemy, t);
    return false;
  }

  // Move toward home
  if (moveTowardFn) {
    moveTowardFn(enemy, enemy.home.x, enemy.home.y);
  }

  return true;
}

/**
 * Heal enemy while retreating
 */
export function regenWhileRetreating(enemy, dtMs) {
  // Support both maxHP and maxHp casing
  const maxHp = enemy.maxHp ?? enemy.maxHP;
  if (!maxHp) return;
  
  const rate = enemy.retreatRegenRate ?? AI.RETREAT_REGEN_RATE;
  const dt = dtMs / 1000;
  const add = maxHp * rate * dt;
  enemy.hp = Math.min(maxHp, enemy.hp + add);
}

/**
 * Called when enemy reaches home and finishes reset
 */
export function finishResetAtHome(enemy, t = nowMs()) {
  enemy.isRetreating = false;
  enemy.state = AI.STATES.UNAWARE;

  // Clear combat state
  enemy.targetId = null;
  enemy.isEngaged = false;
  enemy.isAware = false;

  // Full heal on home arrival (support both maxHP and maxHp casing)
  const maxHp = enemy.maxHp ?? enemy.maxHP;
  if (maxHp) {
    enemy.hp = maxHp;
  }

  // Brief spawn immunity to prevent spawn camping
  enemy.spawnImmunityUntil = t + AI.SPAWN_IMMUNITY_MS;

  // Clear retreat metadata
  enemy.retreatReason = null;
  enemy.retreatStartedAt = null;
  enemy.retreatStuckSince = null;
  enemy.outOfRangeSince = null;
}

// ============================================
// GUARD INTERACTIONS
// ============================================

/**
 * Check if enemy should break off due to nearby guards
 */
export function shouldBreakOffFromGuards(enemy, guards, _t = nowMs()) {
  if (!guards || guards.length === 0) return false;
  
  const enemyLevel = enemy.level ?? 1;

  for (const guard of guards) {
    if (!guard || guard.hp <= 0) continue;
    
    const d = dist(enemy.x, enemy.y, guard.x, guard.y);
    if (d <= AI.GUARD_THREAT_RADIUS) {
      const guardLevel = guard.level ?? 25;
      if (guardLevel >= enemyLevel + AI.GUARD_LEVEL_DELTA_BREAKOFF) {
        return true;
      }
    }
  }
  return false;
}

// ============================================
// LEASH & DEAGGRO CHECKS
// ============================================

/**
 * Check if enemy should start retreating due to leash/deaggro
 * @returns {string|null} Retreat reason or null if should stay engaged
 */
export function checkLeashAndDeaggro(enemy, player, t = nowMs()) {
  if (!enemy.home) {
    enemy.home = { x: enemy.spawnX ?? enemy.x, y: enemy.spawnY ?? enemy.y };
  }

  const dHome = dist(enemy.x, enemy.y, enemy.home.x, enemy.home.y);
  const dPlayer = dist(enemy.x, enemy.y, player.x, player.y);
  const leashRadius = getLeashRadius(enemy);
  const deaggroRadius = computeDeaggroRadius(enemy);

  // Hard leash - too far from home
  if (dHome > leashRadius) {
    return 'leash';
  }

  // Soft disengage - player too far for too long
  if (dPlayer > deaggroRadius) {
    enemy.outOfRangeSince ??= t;
    if (t - enemy.outOfRangeSince > AI.DISENGAGE_GRACE_MS) {
      return 'lost';
    }
  } else {
    // Player back in range, reset timer
    enemy.outOfRangeSince = null;
  }

  return null;
}

// ============================================
// PACK MANAGEMENT
// ============================================

/**
 * Retreat all members of a pack
 */
export function retreatPack(packId, enemies, t = nowMs(), reason = 'pack') {
  if (!packId || !enemies) return;
  
  for (const enemy of enemies) {
    if (enemy.packId === packId && enemy.hp > 0 && !enemy.isRetreating) {
      startRetreat(enemy, t, reason);
    }
  }
}

/**
 * Check if any pack member has exceeded leash significantly
 * (prevents pack from splitting too far)
 */
export function checkPackLeash(packId, enemies, maxExcessTiles = 5) {
  if (!packId || !enemies) return false;
  
  for (const enemy of enemies) {
    if (enemy.packId !== packId || enemy.hp <= 0) continue;
    if (!enemy.home) continue;
    
    const dHome = dist(enemy.x, enemy.y, enemy.home.x, enemy.home.y);
    const leashRadius = getLeashRadius(enemy);
    
    if (dHome > leashRadius + maxExcessTiles) {
      return true;
    }
  }
  return false;
}

// ============================================
// ENEMY INITIALIZATION
// ============================================

/**
 * Initialize enemy with required AI fields
 */
export function initEnemyAI(enemy, spawner = null) {
  const t = nowMs();
  
  // Home point
  enemy.home = enemy.home || { 
    x: spawner?.center?.x ?? enemy.x, 
    y: spawner?.center?.y ?? enemy.y 
  };
  
  // Spawn point (for reference)
  enemy.spawnX = enemy.x;
  enemy.spawnY = enemy.y;
  
  // Ranges (spawner can override)
  enemy.leashRadius = enemy.leashRadius ?? spawner?.leashRadius ?? AI.DEFAULT_LEASH_RADIUS;
  enemy.aggroRadius = enemy.aggroRadius ?? spawner?.aggroRadius ?? AI.DEFAULT_AGGRO_RADIUS;
  enemy.deaggroRadius = computeDeaggroRadius(enemy);
  
  // State
  enemy.state = AI.STATES.UNAWARE;
  enemy.isRetreating = false;
  enemy.isEngaged = false;
  enemy.isAware = false;
  
  // Timers
  enemy.spawnedAt = t;
  enemy.spawnImmunityUntil = t + AI.SPAWN_IMMUNITY_MS;
  enemy.brokenOffUntil = 0;
  enemy.outOfRangeSince = null;
  enemy.lastAggroAt = 0;
  enemy.lastDamagedAt = 0;
  
  // Combat
  enemy.targetId = null;
  enemy.nextAttackAt = 0;
  
  // Effects
  ensureEffects(enemy);
  
  return enemy;
}

