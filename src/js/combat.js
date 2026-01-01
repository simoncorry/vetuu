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
  dist, distCoords, now, shuffleArray,
  initEffects, isImmune, isStunned, isRooted, isSlowed, isVulnerable,
  canMove, canAct, applyEffect, tickEffects, 
  getEffectiveMoveSpeed, getVulnMult,
  gcdReady, skillReady, startGCD, startSkillCD
} from './utils.js';

// Enemy type configurations
const ENEMY_CONFIGS = {
  critter: { weapon: 'claws', aiType: 'melee', weakness: 'physical', resistance: 'energy', hp: 0.7 },
  scav: { weapon: 'scav_pistol', aiType: 'ranged', weakness: 'energy', resistance: null, hp: 0.8 },
  trog_warband: { weapon: 'trog_spear', aiType: 'melee', weakness: 'physical', resistance: 'energy', hp: 1.0 },
  karth_grunt: { weapon: 'karth_rifle', aiType: 'ranged', weakness: 'energy', resistance: 'physical', hp: 1.2 },
  retriever_captain: { weapon: 'boss_blade', aiType: 'aggressive', weakness: null, resistance: null, hp: 3.0 },
  ironcross_guard: { weapon: 'guard_rifle', aiType: 'guard', weakness: null, resistance: null, hp: 2.0 }
};

// Timing constants
const DEFAULT_MOVE_COOLDOWN = 400;

// Drycross protection zone - using rectangular bounds for accurate base coverage
let DRYCROSS_CENTER = { x: 56, y: 42 };

// Base bounds in ORIGINAL coordinates (before map expansion offset)
// The base is bounded by guards at: north y=29, south y=46, west x=44, east x=64
const BASE_BOUNDS_ORIGINAL = {
  minX: 44,  // West guard line
  maxX: 64,  // East guard line
  minY: 29,  // North guard line
  maxY: 46   // South guard line
};

// Expanded base bounds (will be set in initCombat)
let BASE_BOUNDS = { ...BASE_BOUNDS_ORIGINAL };

// Buffer zone around base edges where enemies cannot go
const BASE_EDGE_BUFFER = 4; // Enemies stay at least 4 tiles from the base edge

// Combat rules
const GUARD_LEVEL = 5; // Guard level - enemies can now fight back
const MAX_ENGAGED_ENEMIES = 2; // Only 2 enemies can actively attack at once

// Passive critter threshold (critters below this level are non-aggressive)
const PASSIVE_CRITTER_MAX_LEVEL = 5;

// Level scaling constants
const LEVEL_DAMAGE_BONUS_PER_LEVEL = 0.12;
const LEVEL_DAMAGE_PENALTY_PER_LEVEL = 0.08;
const ALPHA_DAMAGE_BONUS = 0.25;

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

// Melee turn tracker - which enemy attacked last, rotate through
let meleeAttackQueue = [];
let lastMeleeAttacker = null;

// Track currently engaged attackers (max 2 at a time)
let activeAttackers = new Set();

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

  // Update Drycross center and bounds based on expanded map
  if (state.map.meta?.originalOffset) {
    const ox = state.map.meta.originalOffset.x;
    const oy = state.map.meta.originalOffset.y;
    
    DRYCROSS_CENTER = {
      x: 56 + ox,
      y: 42 + oy
    };
    
    // Expand base bounds with offset
    BASE_BOUNDS = {
      minX: BASE_BOUNDS_ORIGINAL.minX + ox,
      maxX: BASE_BOUNDS_ORIGINAL.maxX + ox,
      minY: BASE_BOUNDS_ORIGINAL.minY + oy,
      maxY: BASE_BOUNDS_ORIGINAL.maxY + oy
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
      maxHp: 100 + GUARD_LEVEL * 10,
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

// Enemy attacks a guard
function enemyAttackGuard(enemy, guard) {
  const now = Date.now();
  if (enemy.cooldownUntil > now) return;
  if (!guard.hp || guard.hp <= 0) return;
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.critter;
  const weapon = ENEMY_WEAPONS[config.weapon];
  const dist = distCoords(enemy.x, enemy.y, guard.x, guard.y);
  
  if (dist <= weapon.range && hasLineOfSight(currentState, enemy.x, enemy.y, guard.x, guard.y)) {
    let damage = weapon.baseDamage + Math.floor(enemy.level * 0.8);
    if (enemy.isAlpha) damage = Math.floor(damage * ALPHA_DAMAGE_MULT);
    
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
  
  // Visual feedback - remove guard element or mark as dead
  const guardEl = document.querySelector(`[data-npc-id="${guard.id}"]`);
  if (guardEl) {
    guardEl.classList.add('dying');
    setTimeout(() => {
      guardEl.style.opacity = '0.3';
      guardEl.classList.remove('dying');
    }, 500);
  }
  
  // Respawn guard after 30 seconds
  setTimeout(() => {
    guard.hp = guard.maxHp;
    if (guardEl) {
      guardEl.style.opacity = '1';
    }
    logCombat('Ironcross Guard has recovered!');
  }, 30000);
}

function guardAttack(guard, enemy) {
  const now = Date.now();
  if (guard.cooldownUntil > now) return;

  const weapon = ENEMY_WEAPONS.guard_rifle;
  const dist = distCoords(guard.x, guard.y, enemy.x, enemy.y);

  if (dist <= weapon.range && hasLineOfSight(currentState, guard.x, guard.y, enemy.x, enemy.y)) {
    const damage = weapon.baseDamage;
    enemy.hp -= damage;
    
    showProjectile(guard.x, guard.y, enemy.x, enemy.y, weapon.projectileColor);
    showDamageNumber(enemy.x, enemy.y, damage, true);
    logCombat(`Ironcross Guard blasts ${enemy.name} for ${damage}!`);

    guard.cooldownUntil = now + weapon.cooldown;

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

    const now = Date.now();

    // Update player cooldowns
    for (const key of Object.keys(actionCooldowns)) {
      if (actionCooldowns[key] > 0) actionCooldowns[key] -= 100;
    }
    updateCooldownUI();

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
  const isInCombat = currentState.runtime.activeEnemies.some(e => e.hp > 0 && e.isEngaged);

  if (!isInCombat || timeSinceHit > COMBAT_TIMEOUT) {
    if (now - lastRegenTick >= REGEN_OUT_OF_COMBAT_INTERVAL) {
      lastRegenTick = now;
      
      const hpRegen = Math.ceil(player.maxHp * REGEN_OUT_OF_COMBAT_RATE);
      const senseRegen = Math.ceil(player.maxSense * REGEN_OUT_OF_COMBAT_RATE);
      
      if (player.hp < player.maxHp) {
        player.hp = Math.min(player.maxHp, player.hp + hpRegen);
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
      
      const hpRegen = Math.ceil(player.maxHp * REGEN_IN_COMBAT_RATE);
      const senseRegen = Math.ceil(player.maxSense * REGEN_IN_COMBAT_RATE);
      
      if (player.hp < player.maxHp) {
        player.hp = Math.min(player.maxHp, player.hp + hpRegen);
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
// ENEMY AI - CLEAN REWRITE WITH LEASHING
// ============================================
function processEnemyAI(enemy, now) {
  // Don't engage player in ghost mode or immune
  if (isGhostMode || playerImmunityActive) {
    enemy.isEngaged = false;
    enemy.isAware = false;
    return;
  }
  
  // Status effect checks - stunned enemies can't do anything
  if (isStunned(enemy)) {
    return; // Completely incapacitated
  }
  
  // Initialize state
  if (!enemy.moveCooldown) enemy.moveCooldown = 0;
  if (enemy.isAware === undefined) enemy.isAware = false;
  if (!enemy.lastSeenPlayer) enemy.lastSeenPlayer = 0;
  if (!enemy.state) enemy.state = 'UNAWARE';
  
  const config = ENEMY_CONFIGS[enemy.type] || ENEMY_CONFIGS.critter;
  const weapon = ENEMY_WEAPONS[config.weapon];
  const player = currentState.player;
  const dist = distCoords(enemy.x, enemy.y, player.x, player.y);
  const hasLOS = hasLineOfSight(currentState, enemy.x, enemy.y, player.x, player.y);
  
  // Get behavior params from enemy (set by spawn director) or use defaults
  const aggroType = enemy.aggroType || (isEnemyPassive(enemy) ? 'passive' : 'aggressive');
  const aggroRadius = enemy.aggroRadius || (enemy.isAlpha ? 12 : 8);
  const leashRadius = enemy.leashRadius || (enemy.isAlpha ? 18 : 14);
  const deaggroMs = enemy.deaggroTimeMs || 4000;
  
  // Check if broken off from guard chase - force de-aggro cooldown
  if (enemy.brokenOff && enemy.brokenOffUntil && now < enemy.brokenOffUntil) {
    aiReturnHome(enemy, now, weapon);
    return;
  } else if (enemy.brokenOff) {
    enemy.brokenOff = false;
    enemy.brokenOffUntil = 0;
  }
  
  // Check if too close to guards - smart enemies retreat
  if (shouldRetreatFromGuards(enemy)) {
    aiRetreatFromGuards(enemy, now, weapon);
    // Mark as broken off to prevent re-aggro pinball
    enemy.brokenOff = true;
    enemy.brokenOffUntil = now + 3000;
    enemy.isEngaged = false;
    enemy.isAware = false;
    enemy.state = 'UNAWARE';
    return;
  }

  // Check if at base boundary - retreat to spawn and heal
  if (shouldRetreatFromBase(enemy)) {
    enemy.isEngaged = false;
    enemy.isAware = false;
    enemy.state = 'UNAWARE';
    aiReturnHome(enemy, now, weapon);
    return;
  }
  
  // LEASH CHECK: If enemy is too far from home, return home
  const homeCenter = enemy.homeCenter || { x: enemy.spawnX, y: enemy.spawnY };
  if (homeCenter.x !== undefined && homeCenter.y !== undefined) {
    const distFromHome = distCoords(enemy.x, enemy.y, homeCenter.x, homeCenter.y);
    if (distFromHome > leashRadius) {
      // Too far from home - de-aggro and return
      enemy.isEngaged = false;
      enemy.isAware = false;
      enemy.state = 'UNAWARE';
      aiReturnHome(enemy, now, weapon);
      return;
    }
  }
  
  // Handle different aggro types
  if (aggroType === 'passive') {
    // Passive enemies don't engage unless provoked
    if (!provokedEnemies.has(enemy.id)) {
      enemy.isEngaged = false;
      enemy.isAware = false;
      enemy.state = 'UNAWARE';
      // Return home if away, or idle patrol if at home
      const homeCenter = enemy.homeCenter || { x: enemy.spawnX, y: enemy.spawnY };
      if (homeCenter.x !== undefined) {
        const distFromHome = distCoords(enemy.x, enemy.y, homeCenter.x, homeCenter.y);
        if (distFromHome > 2) {
          aiReturnHome(enemy, now, weapon);
          return;
        }
      }
      if (now >= enemy.moveCooldown && Math.random() < 0.02) {
        aiIdle(enemy, now, weapon);
      }
      return;
    }
  } else if (aggroType === 'conditional') {
    // Conditional aggressive - check conditions
    const isAct3 = currentState.flags?.act3;
    const shouldBeAggressive = isAct3 || provokedEnemies.has(enemy.id);
    
    if (!shouldBeAggressive) {
      // Act like passive unless provoked or conditions met
      if (!provokedEnemies.has(enemy.id)) {
        enemy.isEngaged = false;
        enemy.isAware = false;
        enemy.state = 'UNAWARE';
        // Return home if away
        const homeCenter = enemy.homeCenter || { x: enemy.spawnX, y: enemy.spawnY };
        if (homeCenter.x !== undefined) {
          const distFromHome = distCoords(enemy.x, enemy.y, homeCenter.x, homeCenter.y);
          if (distFromHome > 2) {
            aiReturnHome(enemy, now, weapon);
            return;
          }
        }
        if (now >= enemy.moveCooldown && Math.random() < 0.02) {
          aiIdle(enemy, now, weapon);
        }
        return;
      }
    }
  }
  
  // Awareness logic: enemies must SEE the player to become aware
  if (hasLOS && dist <= aggroRadius) {
    // Spotted the player!
    if (!enemy.isAware) {
      enemy.isAware = true;
      enemy.awareTime = now;
      enemy.state = 'ALERT';
    }
    enemy.lastSeenPlayer = now;
  }
  
  // De-aggro: Lose awareness if player has been out of sight/range for deaggroMs
  if (enemy.isAware && (!hasLOS || dist > aggroRadius * 1.5)) {
    if (now - enemy.lastSeenPlayer > deaggroMs) {
      enemy.isAware = false;
    enemy.isEngaged = false;
      enemy.state = 'UNAWARE';
      // Return home
      aiReturnHome(enemy, now, weapon);
    return;
    }
  }
  
  // Not aware yet - return home if away, otherwise idle
  if (!enemy.isAware || enemy.state === 'UNAWARE') {
    enemy.isEngaged = false;
    
    // Check if enemy needs to return home
    const homeCenter = enemy.homeCenter || { x: enemy.spawnX, y: enemy.spawnY };
    if (homeCenter.x !== undefined && homeCenter.y !== undefined) {
      const distFromHome = distCoords(enemy.x, enemy.y, homeCenter.x, homeCenter.y);
      
      if (distFromHome > 2) {
        // Not at home - return and regenerate
        aiReturnHome(enemy, now, weapon);
        return;
      } else {
        // At home - regenerate health
        if (enemy.hp < enemy.maxHp) {
          if (!enemy.lastRegenTick || now - enemy.lastRegenTick >= ENEMY_REGEN_INTERVAL) {
            const regenAmount = Math.ceil(enemy.maxHp * ENEMY_REGEN_RATE);
            enemy.hp = Math.min(enemy.maxHp, enemy.hp + regenAmount);
            updateEnemyHealthBar(enemy);
            enemy.lastRegenTick = now;
            
            // Clear provoked status when fully healed
            if (enemy.hp >= enemy.maxHp * 0.9) {
              provokedEnemies.delete(enemy.id);
              enemy.isRetreating = false;
            }
          }
        }
      }
    }
    
    // Idle behavior: occasional small movement (patrol) - only if at home
    if (now >= enemy.moveCooldown && Math.random() < 0.03) {
      aiIdle(enemy, now, weapon);
    }
    return;
  }
  
  // Alert phase: just became aware, wait a moment before engaging (warning tell)
  const ALERT_DELAY = 400; // 400ms before engaging
  if (enemy.state === 'ALERT' && now - enemy.awareTime < ALERT_DELAY) {
    enemy.isEngaged = false;
    return;
  }
  
  // Transition to ENGAGED
  enemy.state = 'ENGAGED';
  enemy.isEngaged = true;

  // Route to appropriate AI based on type
  switch (config.aiType) {
    case 'melee':
      aiMelee(enemy, weapon, dist, hasLOS, now);
      break;
    case 'ranged':
      aiRanged(enemy, weapon, dist, hasLOS, now);
      break;
    case 'aggressive':
      aiAggressive(enemy, weapon, dist, hasLOS, now);
      break;
    case 'guard':
      // Guards don't move
      break;
    default:
      aiMelee(enemy, weapon, dist, hasLOS, now);
  }
}

// ============================================
// LEASH & RETREAT SYSTEM
// ============================================
// When enemies disengage (leash, base proximity, guard retreat), they return
// home and regenerate health. This prevents exploit farming and adds realism.

const ENEMY_REGEN_RATE = 0.05; // 5% HP per tick while retreating/at home
const ENEMY_REGEN_INTERVAL = 500; // Regen tick every 500ms
const SPAWN_IMMUNITY_DURATION = 1500; // 1.5s immunity after spawning

// Return to home/spawn point with health regeneration
function aiReturnHome(enemy, now, weapon) {
  const homeCenter = enemy.homeCenter || { x: enemy.spawnX, y: enemy.spawnY };
  
  if (homeCenter.x === undefined || homeCenter.y === undefined) return;
  
  const distFromHome = distCoords(enemy.x, enemy.y, homeCenter.x, homeCenter.y);
  
  // Mark as retreating for health regen
  enemy.isRetreating = true;
  
  // Regenerate health while retreating or at home
  if (!enemy.lastRegenTick || now - enemy.lastRegenTick >= ENEMY_REGEN_INTERVAL) {
    if (enemy.hp < enemy.maxHp) {
      const regenAmount = Math.ceil(enemy.maxHp * ENEMY_REGEN_RATE);
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + regenAmount);
      updateEnemyHealthBar(enemy);
    }
    enemy.lastRegenTick = now;
  }
  
  // At home - stop retreating, continue regen
  if (distFromHome <= 2) {
    // Clear provoked status when fully reset
    if (enemy.hp >= enemy.maxHp * 0.9) {
      provokedEnemies.delete(enemy.id);
      enemy.isRetreating = false;
    }
    return;
  }
  
  // Movement cooldown check
  if (now < enemy.moveCooldown) return;
  
  const moveCD = (weapon?.moveSpeed || DEFAULT_MOVE_COOLDOWN) * 1.5;
  
  // Move toward home
  const dx = Math.sign(homeCenter.x - enemy.x);
  const dy = Math.sign(homeCenter.y - enemy.y);
  
  // Try direct path first
  if (canEnemyMoveTo(enemy.x + dx, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y + dy);
  } else if (dx !== 0 && canEnemyMoveTo(enemy.x + dx, enemy.y, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x + dx, enemy.y);
  } else if (dy !== 0 && canEnemyMoveTo(enemy.x, enemy.y + dy, enemy.id)) {
    updateEnemyPosition(enemy, enemy.x, enemy.y + dy);
  }
  
  enemy.moveCooldown = now + moveCD;
}

// Check if enemy should retreat due to base proximity
function shouldRetreatFromBase(enemy) {
  if (enemy.isBoss) return false;
  
  // If at the base boundary edge, need to retreat
  if (isInsideBaseZone(enemy.x, enemy.y, BASE_EDGE_BUFFER + 1)) {
    return true;
  }
  
  return false;
}

// ============================================
// SPAWN CAMPING PREVENTION
// ============================================
// Newly spawned enemies have brief immunity to prevent players
// from sitting at spawn points and farming easy kills.

function hasSpawnImmunity(enemy) {
  if (!enemy.spawnImmunityUntil) return false;
  return Date.now() < enemy.spawnImmunityUntil;
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

// Provoke an enemy (called when player attacks it)
export function provokeEnemy(enemy) {
  if (!enemy) return;
  
  const now = Date.now();
  
  // Provoke this enemy - make it immediately aware and engaged
  provokedEnemies.add(enemy.id);
  enemy.isAware = true;
  enemy.awareTime = now - 500; // Skip alert delay - they're responding to attack
  enemy.lastSeenPlayer = now;
  enemy.isEngaged = true;
  enemy.state = 'ENGAGED';
  
  // Aggro the entire pack - all pack members become aware and chase
  aggroPack(enemy);
  
  updateEnemyVisuals();
}

// Aggro all members of an enemy's pack
function aggroPack(enemy) {
  // Use packId (new system) or fall back to spawnId (old system)
  const packKey = enemy.packId || enemy.spawnId;
  if (!packKey) return;
  
  const now = Date.now();
  const packMembers = currentState.runtime.activeEnemies.filter(e => {
    if (e.hp <= 0) return false;
    // Match by packId (new system) or spawnId (legacy)
    return (e.packId && e.packId === enemy.packId) || 
           (e.spawnId && e.spawnId === enemy.spawnId);
  });
  
  for (const member of packMembers) {
    // Make them aware and engaged
    member.isAware = true;
    member.awareTime = now - 500; // Skip alert delay - they're responding to attack
    member.lastSeenPlayer = now;
    member.isEngaged = true;
    member.state = 'ENGAGED';
    
    // Also mark as provoked if passive/conditional
    provokedEnemies.add(member.id);
  }
}

// Check if enemy should retreat from nearby guards
function shouldRetreatFromGuards(enemy) {
  // Enemies no longer retreat from guards - they fight back!
  // Only retreat if guard is much higher level (5+ levels above enemy)
  if (enemy.isBoss) return false;
  
  for (const guard of guards) {
    if (!guard.hp || guard.hp <= 0) continue; // Skip dead guards
    const dist = distCoords(enemy.x, enemy.y, guard.x, guard.y);
    // Only retreat if very close to a much higher level guard
    if (dist <= 3 && guard.level > enemy.level + 5) {
      return true;
    }
  }
  return false;
}

// ============================================
// MELEE AI - Surround and take turns
// ============================================
function aiMelee(enemy, weapon, dist, hasLOS, now) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  // Can we attack?
  if (dist <= weapon.range && hasLOS) {
    // Check if it's our turn to attack (rotate through melee attackers)
    if (canMeleeAttack(enemy, now)) {
      if (!enemy.cooldownUntil || now >= enemy.cooldownUntil) {
    enemyAttack(enemy, weapon);
        lastMeleeAttacker = enemy.id;
      }
    } else {
      // Not our turn - only reposition occasionally, not constantly
      if (now >= enemy.moveCooldown && Math.random() < 0.3) {
        moveToSurroundPosition(enemy);
        enemy.moveCooldown = now + moveCD * 1.5;
      }
    }
  } else if (hasLOS) {
    // Have LOS but not in range - advance toward player
    if (now >= enemy.moveCooldown) {
      moveTowardPlayer(enemy);
      enemy.moveCooldown = now + moveCD;
    }
  } else {
    // No LOS - try to find a path, but don't move constantly
    if (now >= enemy.moveCooldown && Math.random() < 0.5) {
      moveToGetLOS(enemy);
      enemy.moveCooldown = now + moveCD * 1.2;
    }
  }
}

// Check if this enemy can actively engage (attack) - max 2 at a time
function canEnemyEngage(enemy, now) {
  // Clean up dead/distant enemies from active attackers
  cleanupActiveAttackers();
  
  // If already an active attacker, they can continue
  if (activeAttackers.has(enemy.id)) {
    return true;
  }
  
  // If we have room for more attackers, this enemy can engage
  if (activeAttackers.size < MAX_ENGAGED_ENEMIES) {
    activeAttackers.add(enemy.id);
    return true;
  }
  
  // Max attackers reached - this enemy must wait and surround
  return false;
}

// Remove dead or distant enemies from active attackers set
function cleanupActiveAttackers() {
  const player = currentState.player;
  
  for (const attackerId of activeAttackers) {
    const enemy = currentState.runtime.activeEnemies.find(e => e.id === attackerId);
    
    // Remove if dead
    if (!enemy || enemy.hp <= 0) {
      activeAttackers.delete(attackerId);
      continue;
    }
    
    // Remove if too far from player (gave up pursuit)
    const dist = distCoords(enemy.x, enemy.y, player.x, player.y);
    if (dist > 12) {
      activeAttackers.delete(attackerId);
    }
  }
}

// Legacy function for compatibility - now uses engagement system
function canMeleeAttack(enemy, now) {
  return canEnemyEngage(enemy, now);
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
function aiRanged(enemy, weapon, dist, hasLOS, now) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  // If player is too close, retreat (always try to escape melee)
  if (dist <= 2 && now >= enemy.moveCooldown) {
        moveAwayFromPlayer(enemy);
    enemy.moveCooldown = now + moveCD;
    return;
  }
  
  // In range with LOS - check if we can engage (max 2 attackers)
  if (dist <= weapon.range && hasLOS) {
    if (canEnemyEngage(enemy, now)) {
      if (!enemy.cooldownUntil || now >= enemy.cooldownUntil) {
      enemyAttack(enemy, weapon);
    }
    } else {
      // Can't engage - find a different angle/position and wait
      if (now >= enemy.moveCooldown && Math.random() < 0.3) {
        moveToFlankPosition(enemy);
        enemy.moveCooldown = now + moveCD * 1.5;
      }
    }
    return;
  }
  
  // No LOS - try to reposition, but not frantically
  if (!hasLOS) {
    if (now >= enemy.moveCooldown && Math.random() < 0.4) {
      moveToGetLOS(enemy);
      enemy.moveCooldown = now + moveCD * 1.3;
    }
    return;
  }
  
  // Out of range with LOS - advance cautiously
  if (now >= enemy.moveCooldown && Math.random() < 0.6) {
      moveTowardPlayerRanged(enemy, weapon.range);
    enemy.moveCooldown = now + moveCD;
  }
}

// ============================================
// AGGRESSIVE AI - For bosses and alphas
// ============================================
function aiAggressive(enemy, weapon, dist, hasLOS, now) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  
  if (dist <= weapon.range && hasLOS) {
    if (!enemy.cooldownUntil || now >= enemy.cooldownUntil) {
    enemyAttack(enemy, weapon);
    }
  } else {
    if (now >= enemy.moveCooldown) {
      moveTowardPlayer(enemy);
      enemy.moveCooldown = now + moveCD;
    }
  }
}

// ============================================
// RETREAT AI
// ============================================
function aiRetreatFromGuards(enemy, now, weapon) {
  const moveCD = weapon.moveSpeed || DEFAULT_MOVE_COOLDOWN;
  if (now < enemy.moveCooldown) return;
  
  enemy.isEngaged = false;
  
  // Find nearest guard and move away
  let nearestGuard = null;
  let nearestDist = Infinity;
  for (const guard of guards) {
    const dist = distCoords(enemy.x, enemy.y, guard.x, guard.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestGuard = guard;
    }
  }
  
  if (nearestGuard) {
    moveAwayFrom(enemy, nearestGuard.x, nearestGuard.y);
  }
  
  enemy.moveCooldown = now + moveCD;
}

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

  // Enemies cannot enter the base zone (rectangular bounds + buffer)
  if (isInsideBaseZone(x, y, BASE_EDGE_BUFFER)) return false;

  // Don't walk on other enemies (but can be adjacent - no gap required in combat)
  for (const other of currentState.runtime.activeEnemies) {
    if (other.id === excludeId) continue;
    if (other.hp <= 0) continue;
    
    // Only block if trying to occupy the exact same tile
      if (other.x === x && other.y === y) return false;
  }

  return true;
}

function updateEnemyPosition(enemy, x, y) {
  // Rooted enemies can't move
  if (isRooted(enemy)) {
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
// ENEMY DAMAGE CALCULATION
// ============================================
function calculateEnemyDamage(enemy, weapon, player) {
  const levelDiff = enemy.level - player.level;
  
  let damage = weapon.baseDamage + Math.floor(enemy.level * 0.8);
  
  if (levelDiff > 0) {
    const levelBonus = Math.pow(1 + LEVEL_DAMAGE_BONUS_PER_LEVEL, levelDiff);
    damage = Math.floor(damage * levelBonus);
    
    if (levelDiff >= 2) {
      damage = Math.floor(damage * (1 + (levelDiff - 1) * 0.1));
    }
  } else if (levelDiff < 0) {
    const levelPenalty = Math.pow(1 - LEVEL_DAMAGE_PENALTY_PER_LEVEL, Math.abs(levelDiff));
    damage = Math.floor(damage * levelPenalty);
  }
  
  if (enemy.isAlpha) {
    damage = Math.floor(damage * (1 + ALPHA_DAMAGE_BONUS));
  }
  
  const defMitigation = Math.floor(player.def * 0.3);
  damage = Math.max(1, damage - defMitigation);
  
  return damage;
}

// ============================================
// ENEMY ATTACK
// ============================================
function enemyAttack(enemy, weapon) {
  if (isGhostMode || playerImmunityActive) return; // Can't attack ghost or immune player
  
  const player = currentState.player;

  if (!hasLineOfSight(currentState, enemy.x, enemy.y, player.x, player.y)) {
    return;
  }

  let damage = calculateEnemyDamage(enemy, weapon, player);

  if (weapon.type === 'ranged') {
    showProjectile(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || '#FF4444');
  } else {
    showMeleeSwipe(enemy.x, enemy.y, player.x, player.y, weapon.projectileColor || '#FF4444');
  }

  player.hp -= damage;
  lastHitTime = Date.now();

  showDamageNumber(player.x, player.y, damage, false, true);
  logCombat(`${enemy.name} hits you for ${damage}!`);

  enemy.cooldownUntil = Date.now() + weapon.cooldown;

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
  
  const isCrit = damage > (weapon.baseDamage || 10) * (weapon.multiplier || 1) * 1.2;
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

  if (action.senseCost) {
  player.sense -= action.senseCost;
  updatePlayerSenseBar();
  }

  showCleaveEffect(player.x, player.y);

  for (const enemy of adjacent) {
    provokeEnemy(enemy);
    let damage = calculateDamage(weapon, enemy, action.multiplier || 1);
    enemy.hp -= damage;
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

function calculateDamage(weapon, target, actionDamage = null) {
  const player = currentState.player;
  const config = ENEMY_CONFIGS[target.type] || {};

  // Use action damage if provided, otherwise use weapon base damage
  const baseDamage = actionDamage || weapon.baseDamage || 10;
  let damage = baseDamage + player.atk;
  damage *= (weapon.multiplier || 1);

  // Weakness/resistance
  if (config.weakness === weapon.damageType) {
    damage *= 1.5;
  } else if (config.resistance === weapon.damageType) {
    damage *= 0.5;
  }

  // Defense mitigation
  const targetDef = target.def || 0;
  damage = Math.max(1, damage - Math.floor(targetDef / 2));

  // Crit chance
  const critChance = 0.05 + (player.luck || 0) * 0.02;
  if (Math.random() < critChance) {
    damage = Math.floor(damage * 1.5);
  }

  return Math.floor(damage);
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
// WEAPON CYCLING
// ============================================
export function cycleWeapon() {
  const weapons = ['laser_rifle', 'energy_pistol', 'vibro_sword'];
  const idx = weapons.indexOf(currentWeapon);
  currentWeapon = weapons[(idx + 1) % weapons.length];

  const weapon = WEAPONS[currentWeapon];
  if (weapon && weapon.actions) {
  weapon.actions.forEach((action, i) => {
    actionMaxCooldowns[i + 1] = action.cooldown;
  });
  }

  logCombat(`Switched to ${weapon?.name || currentWeapon}`);
  updateActionBar();
}

export function setWeapon(weaponKey) {
  if (WEAPONS[weaponKey]) {
    currentWeapon = weaponKey;
    const weapon = WEAPONS[currentWeapon];
    if (weapon?.actions) {
    weapon.actions.forEach((action, i) => {
        actionMaxCooldowns[i + 1] = action.cooldown || 1500;
    });
    }
    updateActionBar();
  }
}

export function getCurrentWeapon() {
  return currentWeapon;
}

export function getWeapons() {
  return WEAPONS;
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
        playerAttack(); 
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
  
  // Don't end combat here - let processAutoAttack handle combat state
  // It will check for engaged/provoked enemies and end combat when appropriate
  
  clearNpcTarget();
  updateTargetFrame();
  updateActionBarState();
}

export function getCurrentTarget() {
  return currentTarget;
}

// ============================================
// ALPHA DAMAGE (for enemy attacks)
// ============================================
const ALPHA_DAMAGE_MULT = 1.35;

// ============================================
// BASE ZONE UTILITY
// ============================================
/**
 * Check if a position is inside or too close to the base
 * Uses rectangular bounds for accurate base coverage
 */
function isInsideBaseZone(x, y, buffer = 0) {
  // Check if position is within base bounds + buffer
  const inBaseX = x >= (BASE_BOUNDS.minX - buffer) && x <= (BASE_BOUNDS.maxX + buffer);
  const inBaseY = y >= (BASE_BOUNDS.minY - buffer) && y <= (BASE_BOUNDS.maxY + buffer);
  return inBaseX && inBaseY;
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
    maxHp: calculateEnemyHP(bossDef.level) * 3,
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

  // Remove from provoked set and active attackers
  provokedEnemies.delete(enemy.id);
  activeAttackers.delete(enemy.id);

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
  
    currentState.player.hp = Math.floor(currentState.player.maxHp / 2);
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
  currentState.player.hp = currentState.player.maxHp;
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
    
    el.style.transition = 'none';
    el.style.transform = `translate3d(${enemy.x * 24}px, ${enemy.y * 24}px, 0)`;
    el.style.backgroundColor = isPassive ? '#B8A038' : enemy.color; // Yellow for passive
    
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
    hpBar.innerHTML = `<span class="enemy-hp-fill" style="width: ${(enemy.hp / enemy.maxHp) * 100}%"></span>`;
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
  
  requestAnimationFrame(() => {
    actorLayer.querySelectorAll('.enemy').forEach(el => {
      const moveSpeed = el.dataset.moveSpeed || DEFAULT_MOVE_COOLDOWN;
      el.style.transition = `transform ${moveSpeed}ms linear, box-shadow 0.15s ease, background-color 0.3s ease`;
    });
  });
}

// Update enemy visuals (called when provoked status changes)
function updateEnemyVisuals() {
  for (const enemy of currentState.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;
    
    const el = document.querySelector(`[data-enemy-id="${enemy.id}"]`);
    if (!el) continue;
    
    const isPassive = isEnemyPassive(enemy) && !provokedEnemies.has(enemy.id);
    
    if (isPassive) {
      el.classList.add('passive');
      el.dataset.passive = 'true';
      el.style.backgroundColor = '#B8A038';
    } else {
      el.classList.remove('passive');
      delete el.dataset.passive;
      el.style.backgroundColor = enemy.color;
    }
    
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

function updateEnemyHealthBar(enemy) {
  const fill = document.querySelector(`[data-enemy-id="${enemy.id}"] .enemy-hp-fill`);
  if (fill) {
    fill.style.width = `${Math.max(0, (enemy.hp / enemy.maxHp) * 100)}%`;
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
  for (const enemy of currentState.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;
    tickEffects(enemy);
    updateEnemyStatusEffects(enemy);
  }
}

// ============================================
// UI UPDATES
// ============================================
function updatePlayerHealthBar() {
  const player = currentState.player;
  const fill = document.getElementById('player-hp-fill');
  const text = document.getElementById('player-hp-text');
  if (fill) fill.style.width = `${(player.hp / player.maxHp) * 100}%`;
  if (text) text.textContent = `${player.hp}/${player.maxHp}`;

  const mainFill = document.getElementById('hp-fill');
  const mainText = document.getElementById('hp-text');
  if (mainFill) mainFill.style.setProperty('--pct', (player.hp / player.maxHp) * 100);
  if (mainText) mainText.textContent = `${player.hp}/${player.maxHp}`;
}

function updatePlayerSenseBar() {
  const player = currentState.player;
  const fill = document.getElementById('player-sense-fill');
  const text = document.getElementById('player-sense-text');
  if (fill) fill.style.width = `${(player.sense / player.maxSense) * 100}%`;
  if (text) text.textContent = `${player.sense}/${player.maxSense}`;

  const mainFill = document.getElementById('sense-fill');
  const mainText = document.getElementById('sense-text');
  if (mainFill) mainFill.style.setProperty('--pct', (player.sense / player.maxSense) * 100);
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
  const weaknessType = frame.querySelector('.weakness-type');

  if (nameEl) nameEl.textContent = currentTarget.name;
  if (levelEl) levelEl.textContent = `Lv.${currentTarget.level}`;
  if (hpFill) hpFill.style.width = `${(currentTarget.hp / currentTarget.maxHp) * 100}%`;
  if (hpText) hpText.textContent = `${Math.max(0, currentTarget.hp)}/${currentTarget.maxHp}`;

  const config = ENEMY_CONFIGS[currentTarget.type];
  if (weaknessType && config?.weakness) {
    weaknessType.textContent = config.weakness;
  } else if (weaknessType) {
    weaknessType.textContent = '—';
  }
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
    const weaknessType = frame.querySelector('.weakness-type');

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
    if (currentNpcTarget.hp !== undefined && currentNpcTarget.maxHp) {
      if (hpFill) hpFill.style.width = `${(currentNpcTarget.hp / currentNpcTarget.maxHp) * 100}%`;
      if (hpText) hpText.textContent = `${Math.max(0, currentNpcTarget.hp)}/${currentNpcTarget.maxHp}`;
    } else {
      if (hpFill) hpFill.style.width = '100%';
      if (hpText) hpText.textContent = '—';
    }

    if (weaknessType) weaknessType.textContent = '—';
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
      overlay.style.height = `${pct}%`;
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
