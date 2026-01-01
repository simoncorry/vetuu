/**
 * VETUU — Shared Utilities
 * Common helpers used across combat, spawning, and movement systems.
 * 
 * NOTE: Status effect CHECK functions (isImmune, isStunned, isRooted, canMove, canAct)
 * are in aiUtils.js - they use the centralized time.js module.
 * 
 * This file contains:
 * - Distance calculations
 * - Status effect APPLICATION and TICKING (uses local now() for perf)
 * - Array utilities
 */

import { nowMs } from './time.js';

// ============================================
// DISTANCE
// ============================================

/**
 * Euclidean distance from coordinates
 */
export function distCoords(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// ============================================
// STATUS EFFECTS - APPLICATION & TICKING
// ============================================
// The CHECK functions (isSlowed, isVulnerable, etc.) that need to query
// effect state are kept here since they're used by combat.js for damage calc.
// The AI-focused checks (isImmune, isStunned, canMove) are in aiUtils.js.

/**
 * Check if entity is slowed
 */
export function isSlowed(e) {
  return (e.effects?.slowUntil ?? 0) > nowMs();
}

/**
 * Check if entity is vulnerable (takes extra damage)
 */
export function isVulnerable(e) {
  return (e.effects?.vulnUntil ?? 0) > nowMs();
}

/**
 * Apply a status effect to a target
 * @param {object} target - Entity to affect
 * @param {object} effect - Effect to apply { type, durationMs, mult? }
 */
export function applyEffect(target, effect) {
  if (!target) return;
  
  // Ensure effects object exists
  if (!target.effects) {
    target.effects = {
      stunUntil: 0,
      rootUntil: 0,
      slowUntil: 0,
      slowMult: 1,
      vulnUntil: 0,
      vulnMult: 1,
      immuneUntil: 0
    };
  }
  
  // Immune targets resist all effects
  if ((target.effects.immuneUntil ?? 0) > nowMs() || target.isImmune === true) {
    return;
  }
  
  const t = nowMs();
  const dur = effect.durationMs ?? 0;
  
  switch (effect.type) {
    case 'stun':
      target.effects.stunUntil = Math.max(target.effects.stunUntil ?? 0, t + dur);
      break;
      
    case 'root':
      target.effects.rootUntil = Math.max(target.effects.rootUntil ?? 0, t + dur);
      break;
      
    case 'slow':
      target.effects.slowUntil = Math.max(target.effects.slowUntil ?? 0, t + dur);
      target.effects.slowMult = Math.max(target.effects.slowMult ?? 1, effect.mult ?? 1.25);
      break;
      
    case 'vuln':
      target.effects.vulnUntil = Math.max(target.effects.vulnUntil ?? 0, t + dur);
      target.effects.vulnMult = Math.max(target.effects.vulnMult ?? 1, effect.mult ?? 1.2);
      break;
      
    case 'immune':
      target.effects.immuneUntil = Math.max(target.effects.immuneUntil ?? 0, t + dur);
      break;
  }
}

/**
 * Clear expired effects and reset multipliers
 */
export function tickEffects(entity) {
  if (!entity.effects) return;
  
  const t = nowMs();
  
  // Reset slow multiplier when slow expires
  if (entity.effects.slowUntil <= t) {
    entity.effects.slowMult = 1;
  }
  
  // Reset vuln multiplier when vuln expires
  if (entity.effects.vulnUntil <= t) {
    entity.effects.vulnMult = 1;
  }
}

/**
 * Get effective move speed with slow factored in
 */
export function getEffectiveMoveSpeed(entity, baseMoveSpeed) {
  const slowActive = isSlowed(entity);
  const slowMult = slowActive ? (entity.effects?.slowMult ?? 1) : 1;
  return Math.round(baseMoveSpeed * slowMult);
}

/**
 * Get damage multiplier from vulnerability
 */
export function getVulnMult(target) {
  if (!isVulnerable(target)) return 1;
  return target.effects?.vulnMult ?? 1;
}

// ============================================
// ARRAY UTILITIES
// ============================================

/**
 * Fisher-Yates shuffle
 */
export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Random integer in range [min, max]
 */
export function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
