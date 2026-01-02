/**
 * VETUU — Authoritative Time Module
 * 
 * Single source of truth for all simulation timing.
 * Uses performance.now() for monotonic, high-resolution time immune to system clock changes.
 * 
 * RULES:
 * - All AI/combat timers use nowMs()
 * - All timestamp comparisons use performance time
 * - Legacy Date.now() timestamps are converted via toPerfTime()
 */

/**
 * Returns the current simulation time in milliseconds.
 * This is the ONLY function that should be used for timing in the game loop.
 * 
 * @returns {number} High-resolution timestamp (ms since page load)
 */
export function nowMs() {
  return performance.now();
}

/**
 * Threshold to detect wall-clock (Date.now) timestamps.
 * Date.now() returns ~1.7e12 (ms since 1970), performance.now() returns ~0-1e6.
 */
const WALL_CLOCK_THRESHOLD = 1e12;

/**
 * Offset to convert Date.now() timestamps to performance.now() space.
 * Calculated once at module load.
 */
const PERF_TO_WALL_OFFSET = Date.now() - performance.now();

/**
 * Convert a timestamp to performance time if it's a wall-clock timestamp.
 * Use this to normalize legacy timestamps that may have been set with Date.now().
 * 
 * @param {number} ts - Timestamp to convert
 * @returns {number} Timestamp in performance.now() space
 */
export function toPerfTime(ts) {
  if (!ts || ts === 0) return ts;
  // If timestamp is very large (wall clock), convert to perf time
  if (ts > WALL_CLOCK_THRESHOLD) {
    return ts - PERF_TO_WALL_OFFSET;
  }
  // Already in perf time
  return ts;
}

/**
 * Convert performance time to wall-clock time (for display/logging only).
 * 
 * @param {number} perfTs - Performance timestamp
 * @returns {number} Wall-clock timestamp (Date.now() space)
 */
export function toWallTime(perfTs) {
  if (!perfTs || perfTs === 0) return perfTs;
  if (perfTs > WALL_CLOCK_THRESHOLD) return perfTs; // Already wall time
  return perfTs + PERF_TO_WALL_OFFSET;
}

/**
 * Check if a timestamp has expired (is in the past).
 * Handles both performance and wall-clock timestamps via normalization.
 * 
 * @param {number} expiresAt - Expiration timestamp
 * @param {number} t - Current time (default: nowMs())
 * @returns {boolean} True if expired
 */
export function isExpired(expiresAt, t = nowMs()) {
  if (!expiresAt || expiresAt === 0) return true;
  return t >= toPerfTime(expiresAt);
}

/**
 * Get remaining time until expiration.
 * 
 * @param {number} expiresAt - Expiration timestamp
 * @param {number} t - Current time (default: nowMs())
 * @returns {number} Remaining ms (0 if expired)
 */
export function remainingMs(expiresAt, t = nowMs()) {
  if (!expiresAt || expiresAt === 0) return 0;
  const remaining = toPerfTime(expiresAt) - t;
  return Math.max(0, remaining);
}

// ============================================
// GUARD RAILS - Prevent Timebase Regressions
// ============================================

// Track if we've already warned about each issue (once per session)
const warnedTimers = new Set();

/**
 * Validate and normalize enemy timers.
 * Logs warnings for suspicious values (Date.now leak or uninitialized garbage).
 * 
 * @param {object} enemy - Enemy entity to check
 * @param {string} context - Where this is being called from (for logging)
 */
export function validateEnemyTimers(enemy, context = 'unknown') {
  if (!enemy) return;
  
  const timerKeys = [
    'cooldownUntil', 'moveCooldown', 'nextAttackAt', 'brokenOffUntil',
    'spawnedAt', 'spawnImmunityUntil', 'provokedUntil', 'awareTime',
    'retreatStartedAt', 'lastAggroAt', 'lastDamagedAt', 'lastRegenTick'
  ];
  
  for (const key of timerKeys) {
    const value = enemy[key];
    if (value === undefined || value === null || value === 0 || value === -Infinity) {
      continue; // Valid initial values
    }
    
    // Check for Date.now() leak (value > 1e12)
    if (value > WALL_CLOCK_THRESHOLD) {
      const warnKey = `${enemy.id}_${key}_wallclock`;
      if (!warnedTimers.has(warnKey)) {
        warnedTimers.add(warnKey);
        console.warn(
          `[TIME] Date.now() leak detected! ${context}: enemy.${key} = ${value} (expected perf time). ` +
          `Converting automatically, but this indicates a bug.`
        );
      }
      // Auto-fix by converting
      enemy[key] = toPerfTime(value);
    }
    
    // Check for garbage/uninitialized value (very negative)
    if (value < -1e9) {
      const warnKey = `${enemy.id}_${key}_garbage`;
      if (!warnedTimers.has(warnKey)) {
        warnedTimers.add(warnKey);
        console.warn(
          `[TIME] Suspicious timer value: ${context}: enemy.${key} = ${value}. Clamping to 0.`
        );
      }
      enemy[key] = 0;
    }
  }
}

/**
 * Validate a single timer value (for guards, player, etc.)
 * Returns the validated/converted value.
 * 
 * @param {number} value - Timer value to check
 * @param {string} name - Name for logging
 * @returns {number} - Validated value
 */
export function validateTimer(value, name = 'timer') {
  if (value === undefined || value === null || value === 0 || value === -Infinity) {
    return value;
  }
  
  // Date.now() leak
  if (value > WALL_CLOCK_THRESHOLD) {
    const warnKey = `${name}_wallclock`;
    if (!warnedTimers.has(warnKey)) {
      warnedTimers.add(warnKey);
      console.warn(`[TIME] Date.now() leak: ${name} = ${value}. Converting.`);
    }
    return toPerfTime(value);
  }
  
  // Garbage value
  if (value < -1e9) {
    const warnKey = `${name}_garbage`;
    if (!warnedTimers.has(warnKey)) {
      warnedTimers.add(warnKey);
      console.warn(`[TIME] Suspicious value: ${name} = ${value}. Clamping to 0.`);
    }
    return 0;
  }
  
  return value;
}

// ============================================
// DAY/NIGHT CYCLE
// ============================================

// Cycle configuration
const DAY_DURATION_MS = 600000;  // 10 minutes real time = 1 full day
let dayStartTime = 0;  // When the current day started
let timeOfDay = 0.35;  // Start at morning (0 = midnight, 0.5 = noon)
let paused = false;
let timeScale = 1.0;  // Speed multiplier (1 = normal, 2 = 2x speed)

/**
 * Initialize the day/night cycle
 * @param {number} startTime - Initial time of day (0-1, default 0.35 = morning)
 */
export function initDayCycle(startTime = 0.35) {
  timeOfDay = startTime;
  dayStartTime = nowMs() - (startTime * DAY_DURATION_MS);
  console.log(`[Time] Day cycle initialized at ${formatTimeOfDay(timeOfDay)}`);
}

/**
 * Update the day/night cycle - call this each frame
 */
export function updateDayCycle() {
  if (paused) return;
  
  const elapsed = (nowMs() - dayStartTime) * timeScale;
  timeOfDay = (elapsed % DAY_DURATION_MS) / DAY_DURATION_MS;
}

/**
 * Get current time of day (0-1)
 * 0.00 = midnight
 * 0.25 = 6 AM (dawn)
 * 0.50 = noon
 * 0.75 = 6 PM (dusk)
 */
export function getTimeOfDay() {
  return timeOfDay;
}

/**
 * Set time of day directly (for debugging/cutscenes)
 */
export function setTimeOfDay(t) {
  timeOfDay = Math.max(0, Math.min(1, t));
  dayStartTime = nowMs() - (timeOfDay * DAY_DURATION_MS);
}

/**
 * Pause/resume the day cycle
 */
export function pauseDayCycle(pause = true) {
  if (pause && !paused) {
    paused = true;
  } else if (!pause && paused) {
    // Adjust start time to maintain current time of day
    dayStartTime = nowMs() - (timeOfDay * DAY_DURATION_MS);
    paused = false;
  }
}

/**
 * Set time scale (speed multiplier)
 */
export function setTimeScale(scale) {
  // Adjust start time to maintain current position
  const currentOffset = timeOfDay * DAY_DURATION_MS;
  timeScale = Math.max(0.1, Math.min(10, scale));
  dayStartTime = nowMs() - (currentOffset / timeScale);
}

/**
 * Get ambient light level (0-1) based on time of day
 * Useful for non-WebGL fallback
 */
export function getAmbientLevel() {
  // Sinusoidal curve: darkest at 0/1, brightest at 0.5
  return 0.2 + 0.8 * Math.sin(timeOfDay * Math.PI);
}

/**
 * Check if it's nighttime
 */
export function isNight() {
  return timeOfDay < 0.25 || timeOfDay > 0.80;
}

/**
 * Check if it's daytime (for gameplay effects)
 */
export function isDay() {
  return timeOfDay >= 0.30 && timeOfDay <= 0.70;
}

/**
 * Format time of day as human-readable string
 */
export function formatTimeOfDay(t = timeOfDay) {
  const hours = Math.floor(t * 24);
  const minutes = Math.floor((t * 24 - hours) * 60);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

/**
 * Get the current phase name
 */
export function getDayPhase() {
  if (timeOfDay < 0.20) return 'night';
  if (timeOfDay < 0.30) return 'dawn';
  if (timeOfDay < 0.50) return 'morning';
  if (timeOfDay < 0.70) return 'afternoon';
  if (timeOfDay < 0.80) return 'evening';
  if (timeOfDay < 0.90) return 'dusk';
  return 'night';
}

// Expose debug tools
if (typeof window !== 'undefined') {
  /**
   * Clear the warning deduplication set (for testing)
   */
  window.VETUU_RESET_TIME_WARNINGS = () => {
    warnedTimers.clear();
    console.log('Time warnings reset');
  };
  
  /**
   * Check time module health
   */
  window.VETUU_TIME_CHECK = () => {
    const now = nowMs();
    const wallNow = Date.now();
    const offset = PERF_TO_WALL_OFFSET;
    return {
      perfNow: now,
      wallNow,
      offset,
      offsetDrift: Math.abs((wallNow - now) - offset),
      warningsIssued: warnedTimers.size
    };
  };
  
  /**
   * Day/night cycle controls
   */
  window.VETUU_DAY_CYCLE = () => ({
    timeOfDay,
    formatted: formatTimeOfDay(),
    phase: getDayPhase(),
    ambientLevel: getAmbientLevel(),
    isNight: isNight(),
    paused,
    timeScale
  });
  
  window.VETUU_SET_HOUR = (hour) => {
    setTimeOfDay(hour / 24);
    return `Set to ${formatTimeOfDay()} (${getDayPhase()})`;
  };
  
  window.VETUU_TIME_SPEED = (scale) => {
    setTimeScale(scale);
    return `Time scale set to ${timeScale}x`;
  };
}

