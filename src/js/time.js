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
// 8 minute cycle total:
// 00:00-06:00 (night): 2 min
// 06:00-12:00 (dawn transition): 2 min  
// 12:00-18:00 (day): 2 min
// 18:00-00:00 (dusk transition): 2 min
const DAY_DURATION_MS = 480000;  // 8 minutes real time = 1 full day
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
 * New schedule:
 * 00:00-06:00 (0.00-0.25): Night - darkest
 * 06:00-12:00 (0.25-0.50): Dawn transition - getting brighter
 * 12:00-18:00 (0.50-0.75): Day - brightest
 * 18:00-00:00 (0.75-1.00): Dusk transition - getting darker
 */
export function getAmbientLevel() {
  const hour = timeOfDay * 24;
  
  if (hour < 6) {
    // Night (00:00-06:00): darkest, slight variation
    return 0.15 + 0.05 * (hour / 6);
  } else if (hour < 12) {
    // Dawn transition (06:00-12:00): 0.2 -> 1.0
    const t = (hour - 6) / 6;
    return 0.2 + 0.8 * t;
  } else if (hour < 18) {
    // Day (12:00-18:00): full brightness
    return 1.0;
  } else {
    // Dusk transition (18:00-00:00): 1.0 -> 0.15
    const t = (hour - 18) / 6;
    return 1.0 - 0.85 * t;
  }
}

/**
 * Get night intensity for lighting (0 = full day, 1 = full night)
 */
export function getNightIntensity() {
  return 1 - getAmbientLevel();
}

/**
 * Check if it's deep nighttime (00:00-06:00) - for NPC sight reduction
 */
export function isDeepNight() {
  const hour = timeOfDay * 24;
  return hour < 6;
}

/**
 * Check if it's nighttime (includes transitions)
 */
export function isNight() {
  const hour = timeOfDay * 24;
  return hour < 6 || hour >= 18;
}

/**
 * Check if it's daytime (12:00-18:00 full day)
 */
export function isDay() {
  const hour = timeOfDay * 24;
  return hour >= 12 && hour < 18;
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
 * Get the current in-game hour (0-23)
 */
export function getHour() {
  return Math.floor(timeOfDay * 24);
}

/**
 * Get the current phase name
 */
export function getDayPhase() {
  const hour = timeOfDay * 24;
  if (hour < 6) return 'night';
  if (hour < 12) return 'dawn';
  if (hour < 18) return 'day';
  return 'dusk';
}

// ============================================
// SUN POSITION & SHADOW SYSTEM
// ============================================

/**
 * Get sun angle based on time of day.
 * 0° = sunrise (6 AM, east)
 * 90° = noon (overhead)
 * 180° = sunset (6 PM, west)
 * Returns null during night (no sun)
 * 
 * @returns {number|null} Sun angle in degrees, or null if nighttime
 */
export function getSunAngle() {
  const hour = timeOfDay * 24;
  
  // Night: no sun (0:00 - 6:00)
  if (hour < 6) return null;
  
  // Day: sun travels 0° to 180° from 6 AM to 6 PM
  if (hour < 18) {
    // Map 6-18 hours to 0-180 degrees
    return ((hour - 6) / 12) * 180;
  }
  
  // Night: no sun (18:00 - 24:00)
  return null;
}

/**
 * Get shadow parameters based on current sun position.
 * Returns CSS-ready values for shadow transforms.
 * 
 * Shadows are prominent and fairly uniform throughout the day:
 * - Slightly stronger at midday (harsh sun)
 * - Slightly softer at night (ambient light)
 * - Dynamic direction/length based on sun position
 * 
 * @returns {{
 *   skewX: number,      // Skew angle in degrees (-36 to +36)
 *   scaleY: number,     // Vertical scale (0.25 to 0.7)
 *   scaleX: number,     // Horizontal scale (1.0 to 1.2)
 *   opacity: number,    // Shadow opacity (0.30 to 0.45)
 *   blur: number        // Blur amount in px (0.5 to 2)
 * }}
 */
export function getShadowParams() {
  const sunAngle = getSunAngle();
  
  // Night: soft ambient shadows (moonlight/torchlight)
  // Still visible but diffuse - uniform direction (straight down)
  if (sunAngle === null) {
    return {
      skewX: 0,
      scaleY: 0.4,
      scaleX: 1.0,
      opacity: 0.30,  // Prominent but softer than daytime
      blur: 2
    };
  }
  
  // Day: dynamic shadows based on sun position
  // skewX: sun at 0° (east) = shadow points west (+36°)
  //        sun at 90° (overhead) = straight down (0°)
  //        sun at 180° (west) = shadow points east (-36°)
  const skewX = (90 - sunAngle) * 0.4; // Range: +36° to -36°
  
  // scaleY: shorter at noon (sun overhead), longer at dawn/dusk
  // At 90° (noon): scaleY = 0.25 (shortest)
  // At 0°/180°: scaleY = 0.7 (longest - dramatic golden hour)
  const angleFromNoon = Math.abs(sunAngle - 90);
  const scaleY = 0.25 + (angleFromNoon / 90) * 0.45; // Range: 0.25 to 0.7
  
  // scaleX: slightly wider at low sun angles
  const scaleX = 1.0 + (angleFromNoon / 90) * 0.2; // Range: 1.0 to 1.2
  
  // opacity: STRONGER at noon (harsh midday sun), slightly less at dawn/dusk
  // This creates uniform but realistic shadows - midday sun casts harder shadows
  // Noon: 0.45, Dawn/Dusk: 0.35
  const opacity = 0.45 - (angleFromNoon / 90) * 0.10; // Range: 0.35 to 0.45
  
  // blur: sharper at noon, slightly softer at dawn/dusk
  const blur = 0.5 + (angleFromNoon / 90) * 1; // Range: 0.5px to 1.5px
  
  return { skewX, scaleY, scaleX, opacity, blur };
}

/**
 * Update CSS custom properties for shadows based on current time.
 * Throttled to avoid expensive style recalculations every frame.
 * Shadows move slowly enough that 2 updates/second is smooth.
 */
let lastShadowUpdate = 0;
const SHADOW_UPDATE_INTERVAL = 500; // ms between shadow CSS updates

export function updateShadowCSS(force = false) {
  const now = performance.now();
  
  // Skip if updated recently (unless forced)
  if (!force && now - lastShadowUpdate < SHADOW_UPDATE_INTERVAL) {
    return;
  }
  lastShadowUpdate = now;
  
  const params = getShadowParams();
  const root = document.documentElement;
  
  root.style.setProperty('--shadow-skew', `${params.skewX.toFixed(1)}deg`);
  root.style.setProperty('--shadow-scale-y', params.scaleY.toFixed(3));
  root.style.setProperty('--shadow-scale-x', params.scaleX.toFixed(3));
  root.style.setProperty('--shadow-opacity', params.opacity.toFixed(3));
  root.style.setProperty('--shadow-blur', `${params.blur.toFixed(1)}px`);
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
    updateShadowCSS(true); // Force immediate shadow update
    
    // Force instant shadow update (bypass 30s CSS transition)
    // The shadows use CSS variables from :root, so we need to:
    // 1. Disable transitions
    // 2. Force style recalculation
    // 3. Re-enable transitions
    const shadows = document.querySelectorAll('.actor > .shadow');
    shadows.forEach(el => {
      // Disable transition
      el.style.transition = 'none';
      // Force synchronous style recalculation by reading a layout property
      void el.offsetWidth;
    });
    
    // Use double-rAF to ensure the no-transition frame is painted first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        shadows.forEach(el => {
          el.style.transition = '';
        });
      });
    });
    
    const params = getShadowParams();
    return `Set to ${formatTimeOfDay()} (${getDayPhase()}) — Shadow: skew=${params.skewX.toFixed(1)}°, scaleY=${params.scaleY.toFixed(2)}, opacity=${params.opacity.toFixed(2)}`;
  };
  
  window.VETUU_TIME_SPEED = (scale) => {
    setTimeScale(scale);
    return `Time scale set to ${timeScale}x`;
  };
  
  // Debug helper: preview shadow at specific hours
  window.VETUU_SHADOW_PREVIEW = () => {
    const hours = [0, 6, 9, 12, 15, 18, 21];
    console.table(hours.map(h => {
      const originalTime = timeOfDay;
      setTimeOfDay(h / 24);
      const params = getShadowParams();
      setTimeOfDay(originalTime); // Restore
      return {
        hour: h,
        sunAngle: getSunAngle()?.toFixed(0) ?? 'null',
        skewX: params.skewX.toFixed(1),
        scaleY: params.scaleY.toFixed(2),
        opacity: params.opacity.toFixed(2),
        blur: params.blur.toFixed(1)
      };
    }));
    return 'Shadow parameters at key hours (current time unchanged)';
  };
}

