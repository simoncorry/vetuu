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
// TIMING CONSTANTS
// ============================================
export const GCD_MS = 1500;
export const AUTO_ATTACK_CD_MS = 1500;

// ============================================
// BASIC ATTACK DEFINITIONS
// ============================================
export const BASIC_ATTACKS = {
  melee: {
    name: 'Sword Strike',
    damage: 10,        // Base sword damage (Phase 6: tune to 9-10)
    range: 1,          // Adjacent tile only
    requiresLOS: true,
    cooldownMs: AUTO_ATTACK_CD_MS,
    type: 'melee'
  },
  ranged: {
    name: 'Rifle Shot',
    damage: 7,         // Base rifle damage (Phase 6: tune to 6-7)
    range: 6,
    requiresLOS: true,
    cooldownMs: AUTO_ATTACK_CD_MS,
    type: 'ranged'
  }
};

// ============================================
// PLAYER ABILITIES (Slots 2-7)
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
    damageMultiplier: 1.5,  // 150% of basic melee damage
    range: 12,              // Can leap from 12 tiles away
    cooldownMs: 8000,
    
    // Execution
    castType: 'instant',
    castTimeMs: 0,
    
    // Special behavior
    isGapCloser: true,
    dashSpeed: 3.0,         // 300% movement speed during dash
    
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
    description: '4 rapid strikes, final hit may freeze',
    slot: 3,
    icon: '⚔️',
    
    // Unlock requirements
    unlockLevel: 8,
    unlockMsq: null,
    
    // Combat properties
    type: 'melee',
    damageMultiplier: 0.75, // Per hit (4 hits × 0.75 = 3.0x total)
    hits: 4,
    hitIntervalMs: 500,     // 2.0s total channel (4 × 500ms)
    range: 1,               // Adjacent tile only
    cooldownMs: 8000,
    
    // Execution
    castType: 'channel',
    castTimeMs: 2000,
    locksMovement: true,
    
    // Special effects
    finalHitEffect: {
      type: 'freeze',
      chance: 0.5,          // 50% chance
      durationMs: 1000      // 1 second freeze
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
    description: '3 rapid shots',
    slot: 4,
    icon: '💥',
    
    // Unlock requirements
    unlockLevel: 12,
    unlockMsq: 'rifle_unlocked',  // Requires Dax MSQ
    
    // Combat properties
    type: 'ranged',
    damageMultiplier: 0.5,  // Per shot (3 shots × 0.5 = 1.5x total)
    shots: 3,
    shotIntervalMs: 150,    // Fast burst
    range: 6,
    cooldownMs: 4000,
    
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
    damageMultiplier: 3.0,  // 300% of basic ranged damage
    range: 6,
    cooldownMs: 10000,
    
    // Execution
    castType: 'cast',
    castTimeMs: 3000,       // 3 second charge
    locksMovement: true,
    
    // GCD behavior: cast abilities lock for full cast time
    gcdMs: 3000,            // GCD = cast time (double GCD)
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
    senseCost: 50,      // 50% of 100% pool (allows double-cast then wait)
    radius: 8,
    pullDistance: 2,
    cooldownMs: 12000,  // 12s - long CD due to 4s stun being very powerful
    
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
    senseCost: 50,      // 50% of 100% pool (allows double-cast then wait)
    radius: 8,
    pushDistance: 2,
    cooldownMs: 8000,   // 8s - shorter CD for spacing/burn damage tool
    
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

