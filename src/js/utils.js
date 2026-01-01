/**
 * VETUU — Shared Utilities
 * Common helpers used across combat, spawning, and movement systems.
 */

// ============================================
// DISTANCE
// ============================================
/**
 * Euclidean distance between two points
 * @param {{x: number, y: number}} a - First point
 * @param {{x: number, y: number}} b - Second point
 * @returns {number} - Distance in tiles
 */
export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Euclidean distance from coordinates
 */
export function distCoords(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// ============================================
// TIMING
// ============================================
export function now() {
  return performance.now();
}

// ============================================
// STATUS EFFECTS SYSTEM
// ============================================
// Minimal effects: stun, root, slow, vuln, immune
// No stacks, no fancy dispels - just timers.

/**
 * Initialize effects object on an entity
 */
export function initEffects(entity) {
  if (!entity.effects) {
    entity.effects = {
      stunUntil: 0,
      rootUntil: 0,
      slowUntil: 0,
      slowMult: 1,
      vulnUntil: 0,
      vulnMult: 1,
      immuneUntil: 0
    };
  }
  return entity.effects;
}

/**
 * Check if entity is immune to damage and CC
 */
export function isImmune(e) {
  return (e.effects?.immuneUntil ?? 0) > now() || e.isImmune === true;
}

/**
 * Check if entity is stunned (can't move or attack)
 */
export function isStunned(e) {
  return (e.effects?.stunUntil ?? 0) > now();
}

/**
 * Check if entity is rooted (can't move, can attack)
 */
export function isRooted(e) {
  return (e.effects?.rootUntil ?? 0) > now();
}

/**
 * Check if entity is slowed
 */
export function isSlowed(e) {
  return (e.effects?.slowUntil ?? 0) > now();
}

/**
 * Check if entity is vulnerable (takes extra damage)
 */
export function isVulnerable(e) {
  return (e.effects?.vulnUntil ?? 0) > now();
}

/**
 * Can entity move? (not stunned or rooted)
 */
export function canMove(e) {
  return !isStunned(e) && !isRooted(e);
}

/**
 * Can entity act/attack? (not stunned)
 */
export function canAct(e) {
  return !isStunned(e);
}

/**
 * Apply a status effect to a target
 * @param {object} target - Entity to affect
 * @param {object} effect - Effect to apply { type, durationMs, mult? }
 */
export function applyEffect(target, effect) {
  if (!target) return;
  initEffects(target);
  
  // Immune targets resist all effects
  if (isImmune(target)) return;
  
  const t = now();
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
  
  const t = now();
  
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
// GCD & COOLDOWN SYSTEM
// ============================================

/**
 * Check if GCD is ready
 */
export function gcdReady(player) {
  return now() >= (player.cooldowns?.gcdUntil ?? 0);
}

/**
 * Check if a specific skill is ready
 */
export function skillReady(player, skillId) {
  return now() >= (player.cooldowns?.skills?.[skillId] ?? 0);
}

/**
 * Start GCD
 */
export function startGCD(player, durationMs = 1500) {
  if (!player.cooldowns) player.cooldowns = { gcdUntil: 0, skills: {} };
  player.cooldowns.gcdUntil = now() + durationMs;
}

/**
 * Start skill cooldown
 */
export function startSkillCD(player, skillId, durationMs) {
  if (!player.cooldowns) player.cooldowns = { gcdUntil: 0, skills: {} };
  if (!player.cooldowns.skills) player.cooldowns.skills = {};
  player.cooldowns.skills[skillId] = now() + durationMs;
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

