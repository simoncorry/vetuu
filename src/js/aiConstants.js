/**
 * VETUU — AI Constants
 * Centralized configuration for enemy AI behavior.
 * 
 * Goals:
 * - Prevent exploit patterns (kiting, spawn camping, guard cheese)
 * - Keep combat readable and fair for new players
 * - Make the world feel consistent: enemies "belong" to an area
 * - Allow players to disengage and regroup
 */

export const AI = {
  // ============================================
  // CORE TIMING
  // ============================================
  
  /** How long target can be out of deaggro range before leash breaks */
  DISENGAGE_GRACE_MS: 1500,
  
  /** Cannot re-aggro after retreat for this duration */
  BROKEN_OFF_MS: 4000,
  
  /** Cannot be damaged/CC'd right after spawn or reset (reduced for difficulty) */
  SPAWN_IMMUNITY_MS: 800,
  
  /** If can't reach home after this time, snap/reset as last resort */
  RETREAT_TIMEOUT_MS: 4000,

  // ============================================
  // HEALING
  // ============================================
  
  /** HP regen rate while retreating (% of maxHP per second) */
  RETREAT_REGEN_RATE: 0.15,

  // ============================================
  // GUARD INTERACTIONS
  // ============================================
  
  /** Distance within which guards are considered a threat */
  GUARD_THREAT_RADIUS: 8,
  
  /** Level difference that triggers guard breakoff */
  GUARD_LEVEL_DELTA_BREAKOFF: 5,
  
  /** Extra broken-off time when retreating due to guards */
  GUARD_BREAKOFF_EXTRA_MS: 2000,

  // ============================================
  // DEFAULT RANGES (spawner/enemy can override)
  // ============================================
  
  /** Default detection radius */
  DEFAULT_AGGRO_RADIUS: 7,
  
  /** Padding added to aggro radius for deaggro (hysteresis) */
  DEFAULT_DEAGGRO_RADIUS_PAD: 9,
  
  /** Default max distance from home while engaged */
  DEFAULT_LEASH_RADIUS: 24,

  // ============================================
  // MOVEMENT & SNAPPING
  // ============================================
  
  /** Distance threshold for "arrived at home" */
  HOME_ARRIVE_EPS: 0.6,
  
  /** Movement speed multiplier while retreating */
  RETREAT_SPEED_MULT: 1.2,

  // ============================================
  // SPAWN PROTECTIONS
  // ============================================
  
  /** Don't spawn enemies within this radius of player */
  NO_SPAWN_RADIUS: 10,
  
  /** Brief settle window after spawn before can aggro */
  SPAWN_SETTLE_MS: 400,

  // ============================================
  // ALERT STATE
  // ============================================
  
  /** Duration of alert state before engaging */
  ALERT_DURATION_MS: 500,

  // ============================================
  // ENEMY STATES (for reference)
  // ============================================
  STATES: {
    UNAWARE: 'UNAWARE',
    ALERT: 'ALERT',
    ENGAGED: 'ENGAGED',
    RETREATING: 'RETREATING',
    DEAD: 'DEAD'
  }
};


