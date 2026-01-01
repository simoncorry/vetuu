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

