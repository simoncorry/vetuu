/**
 * VETUU — Player Abilities (Combat Overhaul)
 * 
 * Unified action bar - no weapon swap, all abilities available.
 * 
 * Bar Layout:
 *   Slot 1: Auto Attack (independent 1.5s timer, NOT on GCD)
 *   Slot 2: Leap (melee)
 *   Slot 3: Blade Flurry (melee, channel)
 *   Slot 4: Burst (ranged)
 *   Slot 5: Charged Shot (ranged, cast)
 *   ---divider---
 *   Slot 6: Sense Pull
 *   Slot 7: Sense Push
 * 
 * GCD Rules:
 *   - Auto attack (slot 1) is INDEPENDENT - not affected by or triggering GCD
 *   - Abilities (slots 2-7) trigger 1.5s GCD and have their own cooldowns
 *   - Channels/casts block actions until complete or cancelled
 * 
 * Cancel Rules:
 *   - Blade Flurry: movement cancels, refunds cooldown
 *   - Charged Shot: movement cancels, refunds cooldown
 */

// ============================================
// BALANCE CONSTANTS (tune all damage/timing here)
// ============================================
export const BALANCE = {
  // Timing (ms)
  gcdMs: 1500,
  autoAttackCdMs: 1500,
  
  // Basic attack damage
  meleeDamage: 10,        // Sword strike (Phase 6 target: 9-10)
  rangedDamage: 7,        // Rifle shot (Phase 6 target: 6-7)
  
  // Ability multipliers (relative to basic attack)
  leapMultiplier: 1.5,         // 150% melee = 15 dmg
  flurryMultiplier: 0.75,      // Per hit (4 × 0.75 = 3.0x total = 30 dmg)
  burstMultiplier: 0.5,        // Per shot (3 × 0.5 = 1.5x total = 10.5 dmg)
  chargedMultiplier: 3.0,      // 300% ranged = 21 dmg
  
  // Ability cooldowns (ms)
  leapCd: 8000,
  flurryCd: 8000,
  burstCd: 4000,
  chargedCd: 10000,
  pullCd: 12000,       // Long due to 4s stun being powerful
  pushCd: 8000,        // Shorter for spacing/burn tool
  
  // Sense abilities
  sensePool: 100,      // Fixed pool (no level scaling)
  senseCost: 50,       // 50% per ability (allows double-cast then wait)
  
  // Ranges (tiles)
  meleeRange: 1,       // Adjacent only
  rangedRange: 6,
  leapRange: 12,       // Gap closer
  senseRadius: 8,
  
  // Flurry channel
  flurryHits: 4,
  flurryHitIntervalMs: 500,    // 2.0s total
  flurryFreezeChance: 0.5,
  flurryFreezeDurationMs: 1000,
  
  // Burst shots
  burstShots: 3,
  burstShotIntervalMs: 150,
  
  // Charged shot cast
  chargedCastMs: 3000,
  
  // Leap dash
  leapDashSpeed: 6.0,  // 600% movement speed - fast airborne woosh
  
  // Sense push/pull distance
  pullDistance: 2,
  pushDistance: 2
};

// ============================================
// TIMING CONSTANTS (derived from BALANCE)
// ============================================
export const GCD_MS = BALANCE.gcdMs;
export const AUTO_ATTACK_CD_MS = BALANCE.autoAttackCdMs;

// ============================================
// BASIC ATTACK DEFINITIONS (derived from BALANCE)
// ============================================
export const BASIC_ATTACKS = {
  melee: {
    name: 'Sword Strike',
    damage: BALANCE.meleeDamage,
    range: BALANCE.meleeRange,
    requiresLOS: true,
    cooldownMs: BALANCE.autoAttackCdMs,
    type: 'melee'
  },
  ranged: {
    name: 'Rifle Shot',
    damage: BALANCE.rangedDamage,
    range: BALANCE.rangedRange,
    requiresLOS: true,
    cooldownMs: BALANCE.autoAttackCdMs,
    type: 'ranged'
  }
};

// ============================================
// PLAYER ABILITIES (Slots 2-7) - derived from BALANCE
// ============================================
export const PLAYER_ABILITIES = {
  // ==========================================
  // SLOT 2: LEAP (Melee)
  // ==========================================
  2: {
    id: 'leap',
    name: 'Leap',
    description: 'Dash to target and strike',
    slot: 2,
    icon: '🦘',
    
    // Unlock requirements
    unlockLevel: 4,
    unlockMsq: null,  // No MSQ required
    
    // Combat properties
    type: 'melee',
    damageMultiplier: BALANCE.leapMultiplier,
    range: BALANCE.leapRange,
    cooldownMs: BALANCE.leapCd,
    
    // Execution
    castType: 'instant',
    castTimeMs: 0,
    
    // Special behavior
    isGapCloser: true,
    dashSpeed: BALANCE.leapDashSpeed,
    
    // Cancel rules
    cancelOnMove: false,    // Instant, no cancel needed
    refundOnCancel: false
  },

  // ==========================================
  // SLOT 3: BLADE FLURRY (Melee, Channel)
  // ==========================================
  3: {
    id: 'blade_flurry',
    name: 'Blade Flurry',
    description: `${BALANCE.flurryHits} rapid strikes, final hit may freeze`,
    slot: 3,
    icon: '⚔️',
    
    // Unlock requirements
    unlockLevel: 8,
    unlockMsq: null,
    
    // Combat properties
    type: 'melee',
    damageMultiplier: BALANCE.flurryMultiplier,
    hits: BALANCE.flurryHits,
    hitIntervalMs: BALANCE.flurryHitIntervalMs,
    range: BALANCE.meleeRange,
    cooldownMs: BALANCE.flurryCd,
    
    // Execution
    castType: 'channel',
    castTimeMs: BALANCE.flurryHits * BALANCE.flurryHitIntervalMs,
    channelTimeMs: BALANCE.flurryHits * BALANCE.flurryHitIntervalMs,
    locksMovement: true,
    
    // Special effects
    finalHitEffect: {
      type: 'freeze',
      chance: BALANCE.flurryFreezeChance,
      durationMs: BALANCE.flurryFreezeDurationMs
    },
    
    // Cancel rules
    cancelOnMove: true,
    refundOnCancel: true    // Full cooldown refund if cancelled
  },

  // ==========================================
  // SLOT 4: BURST (Ranged)
  // ==========================================
  4: {
    id: 'burst',
    name: 'Burst',
    description: `${BALANCE.burstShots} rapid shots`,
    slot: 4,
    icon: '💥',
    
    // Unlock requirements
    unlockLevel: 12,
    unlockMsq: 'rifle_unlocked',  // Requires Dax MSQ
    
    // Combat properties
    type: 'ranged',
    damageMultiplier: BALANCE.burstMultiplier,
    shots: BALANCE.burstShots,
    shotIntervalMs: BALANCE.burstShotIntervalMs,
    range: BALANCE.rangedRange,
    cooldownMs: BALANCE.burstCd,
    
    // Execution
    castType: 'instant',
    castTimeMs: 0,
    
    // Cancel rules
    cancelOnMove: false,
    cancelOnTargetInvalid: true,  // Stop burst if target dies/retreats
    refundOnCancel: false
  },

  // ==========================================
  // SLOT 5: CHARGED SHOT (Ranged, Cast)
  // ==========================================
  5: {
    id: 'charged_shot',
    name: 'Charged Shot',
    description: 'Powerful shot after charging',
    slot: 5,
    icon: '🎯',
    
    // Unlock requirements
    unlockLevel: 16,
    unlockMsq: 'rifle_unlocked',
    
    // Combat properties
    type: 'ranged',
    damageMultiplier: BALANCE.chargedMultiplier,
    range: BALANCE.rangedRange,
    cooldownMs: BALANCE.chargedCd,
    
    // Execution
    castType: 'cast',
    castTimeMs: BALANCE.chargedCastMs,
    locksMovement: true,
    
    // GCD behavior: cast abilities lock for full cast time
    gcdMs: BALANCE.chargedCastMs,
    cooldownOnSuccess: true, // Cooldown only starts when cast completes
    
    // Cancel rules
    cancelOnMove: true,
    refundOnCancel: true,
    clearGcdOnCancel: true  // Don't punish repositioning
  },

  // ==========================================
  // SLOT 6: SENSE PULL
  // ==========================================
  6: {
    id: 'sense_pull',
    name: 'Pull',
    description: 'Pull enemies toward you',
    slot: 6,
    icon: '🧲',
    
    // Unlock requirements
    unlockLevel: 1,
    unlockMsq: 'sense_revealed',  // Hidden until MSQ reveal
    
    // Combat properties
    type: 'sense',
    senseCost: BALANCE.senseCost,
    radius: BALANCE.senseRadius,
    pullDistance: BALANCE.pullDistance,
    cooldownMs: BALANCE.pullCd,
    
    // Execution
    castType: 'instant',
    castTimeMs: 0,
    
    // Cancel rules
    cancelOnMove: false,
    refundOnCancel: false
  },

  // ==========================================
  // SLOT 7: SENSE PUSH
  // ==========================================
  7: {
    id: 'sense_push',
    name: 'Push',
    description: 'Push enemies away from you',
    slot: 7,
    icon: '💨',
    
    // Unlock requirements
    unlockLevel: 1,
    unlockMsq: 'sense_revealed',
    
    // Combat properties
    type: 'sense',
    senseCost: BALANCE.senseCost,
    radius: BALANCE.senseRadius,
    pushDistance: BALANCE.pushDistance,
    cooldownMs: BALANCE.pushCd,
    
    // Execution
    castType: 'instant',
    castTimeMs: 0,
    
    // Cancel rules
    cancelOnMove: false,
    refundOnCancel: false
  }
};

// ============================================
// HELPERS
// ============================================

/**
 * Get ability by slot number
 */
export function getAbility(slot) {
  return PLAYER_ABILITIES[slot] || null;
}

/**
 * Get basic attack for weapon type
 */
export function getBasicAttack(type) {
  return BASIC_ATTACKS[type] || BASIC_ATTACKS.melee;
}

/**
 * Check if ability is unlocked for player
 * @param {number} slot - Ability slot (2-7)
 * @param {object} player - Player state with level
 * @param {object} flags - Game flags for MSQ progress
 */
export function isAbilityUnlocked(slot, player, flags = {}) {
  const ability = PLAYER_ABILITIES[slot];
  if (!ability) return false;
  
  // Check level requirement
  if (player.level < ability.unlockLevel) {
    return false;
  }
  
  // Check MSQ requirement
  if (ability.unlockMsq && !flags[ability.unlockMsq]) {
    return false;
  }
  
  return true;
}

/**
 * Get unlock requirements text for tooltip
 */
export function getUnlockRequirements(slot) {
  const ability = PLAYER_ABILITIES[slot];
  if (!ability) return null;
  
  const reqs = [];
  
  if (ability.unlockLevel > 1) {
    reqs.push(`Level ${ability.unlockLevel}`);
  }
  
  if (ability.unlockMsq === 'rifle_unlocked') {
    reqs.push('Complete Dax quest');
  } else if (ability.unlockMsq === 'sense_revealed') {
    reqs.push('Story progress');
  }
  
  return reqs.length > 0 ? `Unlocks: ${reqs.join(' + ')}` : null;
}

/**
 * Calculate ability damage based on basic attack
 * @param {number} slot - Ability slot
 * @param {string} basicType - 'melee' or 'ranged' (for damage base)
 */
export function calculateAbilityDamage(slot, basicType = null) {
  const ability = PLAYER_ABILITIES[slot];
  if (!ability) return 0;
  
  // Determine which basic attack to use
  const type = basicType || ability.type;
  const basic = BASIC_ATTACKS[type] || BASIC_ATTACKS.melee;
  
  return Math.floor(basic.damage * ability.damageMultiplier);
}

/**
 * Get all abilities for UI display
 */
export function getAllAbilities() {
  return Object.values(PLAYER_ABILITIES);
}

// ============================================
// ENEMY WEAPONS (unchanged from weapons.js)
// ============================================
export const ENEMY_WEAPONS = {
  // Melee weapons (range = 1, adjacent only)
  melee_claws: {
    name: 'Claws',
    type: 'melee',
    combatType: 'melee',
    range: 1,
    baseDamage: 4,
    cooldown: 1200,
    moveSpeed: 350
  },
  melee_bite: {
    name: 'Bite',
    type: 'melee',
    combatType: 'melee',
    range: 1,
    baseDamage: 5,
    cooldown: 1000,
    moveSpeed: 320
  },
  melee_club: {
    name: 'Club',
    type: 'melee',
    combatType: 'melee',
    range: 1,
    baseDamage: 9,
    cooldown: 1300,
    moveSpeed: 380
  },
  melee_spear: {
    name: 'Spear',
    type: 'melee',
    combatType: 'melee',
    range: 1,
    baseDamage: 11,
    cooldown: 1100,
    moveSpeed: 320
  },
  boss_blade: {
    name: 'Captain\'s Blade',
    type: 'melee',
    combatType: 'melee',
    range: 1,
    baseDamage: 20,
    cooldown: 1000,
    moveSpeed: 320
  },

  // Ranged weapons (range = 6)
  ranged_rifle: {
    name: 'Rifle',
    type: 'ranged',
    combatType: 'ranged',
    range: 6,
    baseDamage: 10,
    cooldown: 1600,
    moveSpeed: 450
  },
  ranged_bolt: {
    name: 'Bolt',
    type: 'ranged',
    combatType: 'ranged',
    range: 6,
    baseDamage: 13,
    cooldown: 2000,
    moveSpeed: 480
  },
  karth_laser: {
    name: 'Karth Laser',
    type: 'ranged',
    combatType: 'ranged',
    range: 6,
    baseDamage: 14,
    cooldown: 1600,
    moveSpeed: 420
  },
  guard_rifle: {
    name: 'Guard Rifle',
    type: 'ranged',
    combatType: 'ranged',
    range: 6,
    baseDamage: 18,
    cooldown: 1400,
    moveSpeed: 400
  }
};

// Aliases for existing enemy definitions
ENEMY_WEAPONS.claws = ENEMY_WEAPONS.melee_claws;
ENEMY_WEAPONS.trog_spear = ENEMY_WEAPONS.melee_spear;
ENEMY_WEAPONS.ritual_bolt = ENEMY_WEAPONS.ranged_bolt;

