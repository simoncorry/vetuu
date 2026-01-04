/**
 * VETUU — Weapon Definitions (Simplified)
 * 
 * Combat Simplified Rewrite:
 * - Player has exactly 2 weapons: Rifle (ranged) and Sword (melee)
 * - Standardized ranges: Ranged = 6 tiles, Melee = 1 tile (adjacent only)
 * - No pistols, no casters, no damage types, no weaknesses/resistances
 * - Melee: hits harder and faster, moves faster
 * - Ranged: hits softer, can kite if played well
 * 
 * Basic Attack System:
 * - All weapons share a 1.5s auto-attack cadence
 * - Basic attack (right-click) is separate from weapon abilities (1-3)
 * - Each weapon has a `basic` property defining damage, range, LOS requirements
 */

// ============================================
// BASIC ATTACK CONSTANT (shared cadence)
// ============================================
export const BASIC_ATTACK_CD_MS = 1500;

// ============================================
// PLAYER WEAPONS (only 2)
// ============================================
export const WEAPONS = {
  // ============================================
  // RIFLE - Ranged Combat (6 tile range)
  // ============================================
  laser_rifle: {
    name: 'Rifle',
    type: 'ranged',
    combatType: 'ranged',
    range: 6, // Standardized ranged range
    baseDamage: 10,
    multiplier: 1.0,
    moveSpeed: 450,
    // projectileColor uses CSS var --projectile-player (resolved in combat.js)
    icon: '🔫',
    
    // Basic attack (right-click auto-attack) - lower damage, ranged
    basic: {
      damage: 8,
      range: 6,
      requiresLOS: true,
      cooldownMs: BASIC_ATTACK_CD_MS
    },
    
    // Weapon abilities (1-3) - no Sense cost
    abilities: {
      1: {
        id: 'rifle_burst',
        name: 'Burst',
        description: '3 shots reduced damage',
        cooldownMs: 6000,
        shots: 3,
        damagePerShot: 6,
        range: 6
      },
      2: {
        id: 'rifle_suppress',
        name: 'Suppress',
        description: 'Shot + slow',
        cooldownMs: 10000,
        damage: 10,
        range: 6,
        onHit: [{ type: 'slow', durationMs: 2000, mult: 1.5 }]
      },
      3: {
        id: 'rifle_overcharge',
        name: 'Overcharge',
        description: 'Heavy shot',
        cooldownMs: 20000,
        damage: 30,
        range: 6
      }
    }
  },

  // ============================================
  // SWORD - Melee Combat (1 tile range, adjacent only)
  // ============================================
  vibro_sword: {
    name: 'Sword',
    type: 'melee',
    combatType: 'melee',
    range: 1, // Adjacent only
    baseDamage: 14,
    multiplier: 1.0,
    moveSpeed: 350, // Faster movement for melee
    // projectileColor uses CSS var --melee-player (resolved in combat.js)
    icon: '⚔️',
    
    // Basic attack (right-click auto-attack) - higher damage, melee
    basic: {
      damage: 12,
      range: 1, // Adjacent only
      requiresLOS: true, // Keep consistent with existing system
      cooldownMs: BASIC_ATTACK_CD_MS
    },
    
    // Weapon abilities (1-3) - no Sense cost
    abilities: {
      1: {
        id: 'sword_cleave',
        name: 'Cleave',
        description: 'Small AoE',
        cooldownMs: 6000,
        damage: 12,
        range: 1, // Adjacent only
        aoe: { radius: 1.5, maxTargets: 3 }
      },
      2: {
        id: 'sword_lunge',
        name: 'Lunge',
        description: 'Close then strike (target within 4)',
        cooldownMs: 10000,
        damage: 16,
        range: 4, // Can lunge from further away
        dashTiles: 2
      },
      3: {
        id: 'sword_shockwave',
        name: 'Shockwave',
        description: 'AoE + small knockback',
        cooldownMs: 20000,
        damage: 20,
        range: 1, // Adjacent only
        aoe: { radius: 2, maxTargets: 5 },
        knockbackTiles: 1
      }
    }
  }
};

// Aliases for compatibility
WEAPONS.rifle = WEAPONS.laser_rifle;
WEAPONS.sword = WEAPONS.vibro_sword;

// ============================================
// ENEMY WEAPONS (simplified - melee or ranged only)
// ============================================
// Note: projectileColor now uses CSS variables (resolved in combat.js)
// --projectile-enemy for enemies, --melee-enemy for melee attacks
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

// Kept aliases for existing enemy definitions
ENEMY_WEAPONS.claws = ENEMY_WEAPONS.melee_claws;
ENEMY_WEAPONS.trog_spear = ENEMY_WEAPONS.melee_spear;
ENEMY_WEAPONS.ritual_bolt = ENEMY_WEAPONS.ranged_bolt;

// ============================================
// HELPER: Get weapon ability by slot
// ============================================
export function getWeaponAbility(weaponId, slot) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.abilities) return null;
  return weapon.abilities[slot] || null;
}

// ============================================
// HELPER: Get all abilities for a weapon
// ============================================
export function getWeaponAbilities(weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.abilities) return [];
  return Object.entries(weapon.abilities).map(([slot, ability]) => ({
    slot: parseInt(slot, 10),
    ...ability
  }));
}

// ============================================
// HELPER: Get weapon info for UI
// ============================================
export function getWeaponInfo(weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon) return null;
  return {
    name: weapon.name,
    icon: weapon.icon,
    type: weapon.combatType,
    range: weapon.range
  };
}
