/**
 * VETUU — Performance Monitoring (Dev-only)
 * 
 * Provides timing, call counts, and "fan detector" warnings.
 * Enable with: localStorage.setItem('vetuu_perf', '1')
 * 
 * Usage:
 *   import { perfStart, perfEnd, VETUU_PERF } from './perf.js';
 *   
 *   perfStart('fog:update');
 *   // ... work ...
 *   perfEnd('fog:update');
 *   
 *   // In console: VETUU_PERF()
 */

// ============================================
// CONFIG
// ============================================
const ENABLED = () => localStorage.getItem('vetuu_perf') === '1';
const SPIKE_THRESHOLD_MS = 12; // Log warning if any tick exceeds this
const REPORT_INTERVAL_MS = 5000; // How often to aggregate stats

// ============================================
// STATE
// ============================================
const metrics = new Map();
const activeTicks = new Map(); // For nested timing

// Metric structure:
// {
//   count: number,
//   totalMs: number,
//   maxMs: number,
//   lastMs: number,
//   spikes: number (count of times > SPIKE_THRESHOLD_MS)
// }

function getOrCreateMetric(name) {
  if (!metrics.has(name)) {
    metrics.set(name, {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      spikes: 0
    });
  }
  return metrics.get(name);
}

// ============================================
// TIMING API
// ============================================

/**
 * Start timing a named operation.
 */
export function perfStart(name) {
  if (!ENABLED()) return;
  activeTicks.set(name, performance.now());
}

/**
 * End timing and record the metric.
 */
export function perfEnd(name) {
  if (!ENABLED()) return;
  
  const start = activeTicks.get(name);
  if (start === undefined) return;
  
  const duration = performance.now() - start;
  activeTicks.delete(name);
  
  const m = getOrCreateMetric(name);
  m.count++;
  m.totalMs += duration;
  m.lastMs = duration;
  if (duration > m.maxMs) m.maxMs = duration;
  
  // Fan detector: warn on spikes
  if (duration > SPIKE_THRESHOLD_MS) {
    m.spikes++;
    console.warn(`[PERF SPIKE] ${name}: ${duration.toFixed(2)}ms (threshold: ${SPIKE_THRESHOLD_MS}ms)`);
  }
}

/**
 * Record a single call (for counting without timing).
 */
export function perfCount(name) {
  if (!ENABLED()) return;
  const m = getOrCreateMetric(name);
  m.count++;
}

/**
 * Wrap a function with automatic timing.
 */
export function perfWrap(name, fn) {
  if (!ENABLED()) return fn;
  
  return function(...args) {
    perfStart(name);
    const result = fn.apply(this, args);
    perfEnd(name);
    return result;
  };
}

// ============================================
// REPORTING
// ============================================

let lastReportTime = 0;
let lastReportCounts = new Map();

/**
 * Get current performance stats.
 * Called via console: VETUU_PERF()
 */
export function VETUU_PERF() {
  const now = performance.now();
  const elapsed = lastReportTime ? (now - lastReportTime) / 1000 : 0;
  
  console.group('%c[VETUU PERF]', 'color: #0af; font-weight: bold');
  
  // DOM stats
  const actorLayer = document.getElementById('actor-layer');
  const enemyCount = actorLayer?.querySelectorAll('.enemy').length || 0;
  const totalNodes = actorLayer?.childElementCount || 0;
  console.log(`DOM: ${enemyCount} enemies, ${totalNodes} total actor nodes`);
  
  // Fog canvas stats
  const fogCanvas = document.getElementById('fog-canvas');
  if (fogCanvas) {
    console.log(`Fog canvas: ${fogCanvas.width}×${fogCanvas.height}px`);
  }
  
  console.log('');
  console.log('%cMetrics:', 'font-weight: bold');
  
  // Table data
  const tableData = [];
  
  for (const [name, m] of metrics) {
    const prevCount = lastReportCounts.get(name) || 0;
    const callsThisPeriod = m.count - prevCount;
    const callsPerSec = elapsed > 0 ? (callsThisPeriod / elapsed).toFixed(1) : '—';
    const avgMs = m.count > 0 ? (m.totalMs / m.count).toFixed(2) : '0';
    
    tableData.push({
      name,
      'calls': m.count,
      'calls/s': callsPerSec,
      'avg ms': avgMs,
      'max ms': m.maxMs.toFixed(2),
      'last ms': m.lastMs.toFixed(2),
      'spikes': m.spikes
    });
    
    lastReportCounts.set(name, m.count);
  }
  
  if (tableData.length > 0) {
    console.table(tableData);
  } else {
    console.log('No metrics recorded yet. Move around to generate data.');
  }
  
  console.groupEnd();
  
  lastReportTime = now;
  
  return { metrics: Object.fromEntries(metrics), enemyCount, totalNodes };
}

/**
 * Reset all metrics.
 */
export function perfReset() {
  metrics.clear();
  activeTicks.clear();
  lastReportCounts.clear();
  lastReportTime = 0;
  console.log('[PERF] Metrics reset');
}

/**
 * Enable performance monitoring.
 */
export function perfEnable() {
  localStorage.setItem('vetuu_perf', '1');
  console.log('[PERF] Enabled. Call VETUU_PERF() to see stats.');
}

/**
 * Disable performance monitoring.
 */
export function perfDisable() {
  localStorage.removeItem('vetuu_perf');
  console.log('[PERF] Disabled');
}

// ============================================
// GLOBAL EXPOSURE
// ============================================

// Expose to console
if (typeof window !== 'undefined') {
  window.VETUU_PERF = VETUU_PERF;
  window.perfReset = perfReset;
  window.perfEnable = perfEnable;
  window.perfDisable = perfDisable;
}

