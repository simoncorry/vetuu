/**
 * VETUU — Weapon Definitions
 * Sharp weapon identities with distinct playstyles.
 * 
 * Rifle: Long range control, slow, penalized up close
 * Pistol: Mobile mid-range, fast, can fire while moving
 * Sword: High melee DPS, gap close, crowd control
 * 
 * BACKWARD COMPATIBLE: Includes legacy `baseDamage`, `multiplier`, `actions[]`
 * for existing combat.js code while also having new `skills` structure.
 */

export const WEAPONS = {
  // ============================================
  // RIFLE - Long Range Control
  // ============================================
  laser_rifle: {
    name: 'Laser Rifle',
    type: 'ranged',
    damageType: 'energy',
    range: 10,
    baseDamage: 12,
    multiplier: 1.0,
    minRangePenalty: { within: 2, damageMult: 0.65 }, // -35% inside 2 tiles
    moveSpeed: 550, // Slower movement
    projectileColor: '#00FF88',
    
    // Legacy actions array for backward compat
    actions: [
      { name: 'Aimed Shot', type: 'attack', cooldown: 1500, damage: 12 },
      { name: 'Suppressing Fire', type: 'aimed', cooldown: 5000, damage: 8, shots: 3 },
      { name: 'Piercing Beam', type: 'special', cooldown: 20000, damage: 35, senseCost: 30, pierce: 2 }
    ],
    
    // New skill system
    skills: {
      auto: {
        id: 'rifle_1',
        name: 'Aimed Shot',
        key: 1,
        type: 'attack',
        gcdMs: 1500,
        cdMs: 0,
        range: 10,
        damage: 12,
        windupMs: 120,
        description: 'Precise energy bolt'
      },
      mid: {
        id: 'rifle_2',
        name: 'Suppressing Fire',
        key: 2,
        type: 'aimed',
        gcdMs: 1500,
        cdMs: 5000,
        range: 10,
        damage: 8,
        shots: 3,
        shotDelayMs: 150,
        windupMs: 120,
        onHit: [{ type: 'slow', durationMs: 2000, mult: 1.25 }],
        description: 'Three quick shots that slow the target'
      },
      heavy: {
        id: 'rifle_3',
        name: 'Piercing Beam',
        key: 3,
        type: 'special',
        gcdMs: 1500,
        cdMs: 20000,
        senseCost: 30,
        range: 10,
        damage: 35,
        windupMs: 320,
        pierce: 2, // Hits up to 2 units in line
        bonusVs: { tag: 'alpha', damageMult: 1.2 },
        description: 'Devastating beam that pierces through enemies'
      }
    }
  },

  // ============================================
  // PISTOL - Mobile Mid-Range
  // ============================================
  energy_pistol: {
    name: 'Energy Pistol',
    type: 'ranged',
    damageType: 'energy',
    range: 6,
    baseDamage: 9,
    multiplier: 1.0,
    moveSpeed: 350, // Fast movement
    canFireWhileMoving: true,
    projectileColor: '#00FFFF',
    
    // Legacy actions array
    actions: [
      { name: 'Quick Shot', type: 'attack', cooldown: 1500, damage: 9 },
      { name: 'Double Tap', type: 'double', cooldown: 5000, damage: 14, extraShot: { damage: 10, delayMs: 120 } },
      { name: 'Stun Blast', type: 'special', cooldown: 20000, damage: 18, senseCost: 25, onHit: [{ type: 'stun', durationMs: 800 }] }
    ],
    
    // New skill system
    skills: {
      auto: {
        id: 'pistol_1',
        name: 'Quick Shot',
        key: 1,
        type: 'attack',
        gcdMs: 1500,
        cdMs: 0,
        range: 6,
        damage: 9,
        windupMs: 80,
        description: 'Fast energy blast'
      },
      mid: {
        id: 'pistol_2',
        name: 'Double Tap',
        key: 2,
        type: 'double',
        gcdMs: 1500,
        cdMs: 5000,
        range: 6,
        damage: 14,
        windupMs: 60,
        extraShot: { damage: 10, delayMs: 120 },
        description: 'Two rapid shots in quick succession'
      },
      heavy: {
        id: 'pistol_3',
        name: 'Stun Blast',
        key: 3,
        type: 'special',
        gcdMs: 1500,
        cdMs: 20000,
        senseCost: 25,
        range: 6,
        damage: 18,
        windupMs: 180,
        onHit: [{ type: 'stun', durationMs: 800 }],
        description: 'Concussive blast that stuns the target'
      }
    }
  },

  // ============================================
  // SWORD - Melee Commitment
  // ============================================
  vibro_sword: {
    name: 'Vibro Sword',
    type: 'melee',
    damageType: 'physical',
    range: 1.5, // Euclidean: adjacent including diagonal (~1.41)
    baseDamage: 14,
    multiplier: 1.0,
    moveSpeed: 420,
    projectileColor: '#FF00FF', // For visual effects
    
    // Legacy actions array
    actions: [
      { name: 'Slash', type: 'attack', cooldown: 1500, damage: 14, cleave: { maxTargets: 2, splashMult: 0.5 } },
      { name: 'Lunge', type: 'dash', cooldown: 5000, damage: 18, dashTiles: 2, range: 3.0, onHit: [{ type: 'root', durationMs: 600 }] },
      { name: 'Whirlwind', type: 'cleave', cooldown: 20000, damage: 22, senseCost: 35, aoe: { radius: 1.5, maxTargets: 4 }, knockbackTiles: 1 }
    ],
    
    // New skill system
    skills: {
      auto: {
        id: 'sword_1',
        name: 'Slash',
        key: 1,
        type: 'attack',
        gcdMs: 1500,
        cdMs: 0,
        range: 1.5,
        damage: 14,
        windupMs: 90,
        cleave: { maxTargets: 2, splashMult: 0.5 },
        description: 'Powerful slash that can hit nearby enemies'
      },
      mid: {
        id: 'sword_2',
        name: 'Lunge',
        key: 2,
        type: 'dash',
        gcdMs: 1500,
        cdMs: 5000,
        range: 3.0, // Lunge reach
        dashTiles: 2, // Move Rex 2 tiles toward target
        damage: 18,
        windupMs: 120,
        onHit: [{ type: 'root', durationMs: 600 }],
        description: 'Dash forward and root the target in place'
      },
      heavy: {
        id: 'sword_3',
        name: 'Whirlwind',
        key: 3,
        type: 'cleave',
        gcdMs: 1500,
        cdMs: 20000,
        senseCost: 35,
        range: 1.5,
        damage: 22,
        windupMs: 220,
        aoe: { radius: 1.5, maxTargets: 4 },
        onHit: [{ type: 'slow', durationMs: 2500, mult: 1.35 }],
        knockbackTiles: 1,
        description: 'Spinning attack that slows and knocks back enemies'
      }
    }
  }
};

// Aliases for old key names
WEAPONS.rifle = WEAPONS.laser_rifle;
WEAPONS.pistol = WEAPONS.energy_pistol;
WEAPONS.sword = WEAPONS.vibro_sword;

// ============================================
// ENEMY WEAPONS (simpler, no skills)
// ============================================
export const ENEMY_WEAPONS = {
  // Critters
  claws: {
    name: 'Claws',
    type: 'melee',
    range: 1.5,
    baseDamage: 4,
    cooldown: 1200,
    moveSpeed: 400,
    projectileColor: '#6B5B4F'
  },
  melee_bite: {
    name: 'Bite',
    type: 'melee',
    range: 1.5,
    baseDamage: 5,
    cooldown: 1000,
    moveSpeed: 380,
    projectileColor: '#6B5B4F'
  },
  
  // Scavs
  scav_pistol: {
    name: 'Scav Pistol',
    type: 'ranged',
    range: 5,
    baseDamage: 7,
    cooldown: 1400,
    moveSpeed: 380,
    projectileColor: '#9B59B6' // Purple for Verdleg/Scavs
  },
  scav_rifle: {
    name: 'Scav Rifle',
    type: 'ranged',
    range: 7,
    baseDamage: 10,
    cooldown: 1800,
    moveSpeed: 500,
    projectileColor: '#9B59B6'
  },
  melee_club: {
    name: 'Club',
    type: 'melee',
    range: 1.5,
    baseDamage: 9,
    cooldown: 1300,
    moveSpeed: 420,
    projectileColor: '#9B59B6'
  },
  
  // Trogs
  trog_spear: {
    name: 'Trog Spear',
    type: 'melee',
    range: 1.5,
    baseDamage: 11,
    cooldown: 1100,
    moveSpeed: 360,
    projectileColor: '#2ECC71' // Green for Ironcross
  },
  ritual_bolt: {
    name: 'Ritual Bolt',
    type: 'ranged',
    range: 6,
    baseDamage: 13,
    cooldown: 2000,
    moveSpeed: 480,
    projectileColor: '#2ECC71'
  },
  
  // Karth
  karth_rifle: {
    name: 'Karth Laser',
    type: 'ranged',
    range: 8,
    baseDamage: 14,
    cooldown: 1600,
    moveSpeed: 450,
    projectileColor: '#E74C3C' // Red for Karth
  },
  karth_pistol: {
    name: 'Karth Sidearm',
    type: 'ranged',
    range: 5,
    baseDamage: 10,
    cooldown: 1200,
    moveSpeed: 380,
    projectileColor: '#E74C3C'
  },
  
  // Guards
  guard_rifle: {
    name: 'Guard Rifle',
    type: 'ranged',
    range: 6,
    baseDamage: 18,
    cooldown: 1400,
    moveSpeed: 400,
    projectileColor: '#3498DB' // Blue for friendlies
  },
  
  // Boss
  boss_blade: {
    name: 'Captain\'s Blade',
    type: 'melee',
    range: 2,
    baseDamage: 20,
    cooldown: 1000,
    moveSpeed: 350,
    projectileColor: '#8B45D6'
  }
};

// ============================================
// HELPER: Get skill by key
// ============================================
export function getSkillByKey(weaponId, key) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.skills) return null;
  
  for (const skill of Object.values(weapon.skills)) {
    if (skill.key === key) return skill;
  }
  return null;
}

// ============================================
// HELPER: Get all skills as array
// ============================================
export function getWeaponSkills(weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.skills) return [];
  return Object.values(weapon.skills);
}
