/**
 * VETUU — Movement System
 * Clean, unified movement handling with smooth transitions
 * 
 * ANIMATION RULE: All motion uses CSS transitions/animations for GPU acceleration.
 * JavaScript only sets final positions - CSS handles interpolation.
 * Always use translate3d() for transforms, never translate().
 */

import { tryExecuteCombatIntent, cancelCombatPursuit } from './combat.js';
import { actorTransform, TILE_SIZE } from './render.js';

// ============================================
// CONSTANTS
// ============================================
const MOVE_DURATION = 280; // ms per tile - Classic WoW pacing (slower, tactical)
const DIAGONAL_MULTIPLIER = Math.SQRT2; // ~1.414 - diagonal moves take longer to maintain consistent speed
const SPRINT_BUFF_MULTIPLIER = 0.59; // Sprint buff: 70% faster (1/1.7 ≈ 0.59)
const GHOST_MULTIPLIER = 0.5; // Ghost mode is 2x faster (corpse run)
const SPRINT_BUFF_DURATION = 8000; // Sprint buff lasts 8 seconds

// ============================================
// STATE
// ============================================
let state = null;
let playerEl = null;

// Movement state
let isMoving = false;
let currentTween = null;

// Keyboard state
const keysHeld = new Set();
let lastKeyDirection = null;

// Path state
let currentPath = [];
let pathMarkers = [];
let interactOnArrival = false;

// Sprint buff state
let sprintBuffActive = false;
let sprintBuffTimeout = null;

// Callbacks
let onMoveComplete = null;
let onInteract = null;
let onMoveStart = null; // Called at start of move for camera sync

// ============================================
// INITIALIZATION
// ============================================
export function initMovement(gameState, callbacks = {}) {
  state = gameState;
  playerEl = document.getElementById('player');
  
  if (!playerEl) {
    console.error('Movement: #player element not found! Ensure renderActors() is called first.');
  }
  
  onMoveComplete = callbacks.onMoveComplete || (() => {});
  onInteract = callbacks.onInteract || (() => {});
  onMoveStart = callbacks.onMoveStart || (() => {});
  
  // Keyboard listeners
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  
  // Initial position (no animation)
  if (playerEl && state?.player) {
    visualX = state.player.x;
    visualY = state.player.y;
    setPlayerPosition(state.player.x, state.player.y, false);
  }
  
  // Movement tick is now called from main game loop (game.js)
  console.log('Movement system initialized');
}

// ============================================
// MAIN MOVEMENT TICK (called from game.js main loop)
// ============================================

/**
 * Tick movement system - called from main game loop
 * @param {number} deltaTime - Time since last frame in ms
 */
export function tickMovement(deltaTime) {
  // Process active tween
  if (currentTween) {
    updateTween(deltaTime);
  }
  
  // If not moving, check for new movement input
  if (!isMoving) {
    processMovementInput();
  }
}

// ============================================
// INPUT PROCESSING
// ============================================
let cachedDialoguePanel = null;

function processMovementInput() {
  // Block movement if dialogue is open (cache element on first access)
  if (!cachedDialoguePanel) {
    cachedDialoguePanel = document.getElementById('dialogue-panel');
  }
  if (cachedDialoguePanel?.open) return;
  
  // Priority 1: Keyboard input (always takes precedence)
  if (lastKeyDirection) {
    const { dx, dy } = lastKeyDirection;
    attemptMove(dx, dy);
    return;
  }
  
  // Priority 2: Path following
  if (currentPath.length > 0) {
    const nextStep = currentPath[0];
    const dx = nextStep.x - state.player.x;
    const dy = nextStep.y - state.player.y;
    
    // Validate step (must be adjacent)
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx !== 0 || dy !== 0)) {
      if (attemptMove(dx, dy, false)) {
        // Consume the step on successful move
        currentPath.shift();
        removeFirstPathMarker();
      }
    } else {
      // Invalid path step, cancel
      cancelPath();
    }
  }
}

// ============================================
// MOVEMENT EXECUTION
// ============================================

/**
 * Check if a diagonal move would cut through a corner.
 * For diagonal moves, both adjacent cardinal directions must be passable.
 * Example: Moving NE requires both N and E to be passable.
 */
function wouldCutCorner(fromX, fromY, dx, dy) {
  // Only check for diagonal moves
  if (dx === 0 || dy === 0) return false;
  
  // Check the two cardinal tiles adjacent to the diagonal path
  const cardinalX = fromX + dx; // Horizontal neighbor
  const cardinalY = fromY + dy; // Vertical neighbor
  
  // If either adjacent cardinal tile is blocked, diagonal would cut corner
  const horizontalBlocked = !canMoveTo(cardinalX, fromY);
  const verticalBlocked = !canMoveTo(fromX, cardinalY);
  
  return horizontalBlocked || verticalBlocked;
}

function attemptMove(dx, dy) {
  if (isMoving) return false;
  
  // Validate direction
  if (dx === 0 && dy === 0) return false;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  
  const newX = state.player.x + dx;
  const newY = state.player.y + dy;
  
  // Check collision at target
  if (!canMoveTo(newX, newY)) {
    return false;
  }
  
  // Check corner cutting for diagonal moves
  if (wouldCutCorner(state.player.x, state.player.y, dx, dy)) {
    return false;
  }
  
  // Start movement
  startMove(newX, newY);
  return true;
}

// Visual position for smooth animation (separate from logical position)
let visualX = 0;
let visualY = 0;

function startMove(targetX, targetY) {
  isMoving = true;
  
  // Check if this is a diagonal move
  const dx = targetX - state.player.x;
  const dy = targetY - state.player.y;
  const isDiagonal = dx !== 0 && dy !== 0;
  
  // Check if in ghost mode (corpse run) for 2x speed
  const isGhost = playerEl?.classList.contains('ghost');
  
  // Calculate base duration: ghost mode > sprint buff > normal
  let duration = MOVE_DURATION;
  if (isGhost) {
    duration = MOVE_DURATION * GHOST_MULTIPLIER; // 2x faster during corpse run
  } else if (sprintBuffActive) {
    duration = MOVE_DURATION * SPRINT_BUFF_MULTIPLIER; // 70% faster with sprint buff
  }
  
  // Scale for diagonal movement (maintains consistent speed)
  if (isDiagonal) {
    duration *= DIAGONAL_MULTIPLIER;
  }
  
  // Store start position for animation
  const startX = state.player.x;
  const startY = state.player.y;
  
  // Update logical position immediately
  state.player.x = targetX;
  state.player.y = targetY;
  
  // Setup animation - disable CSS transition, we'll animate manually
  if (playerEl) {
    playerEl.classList.add('moving');
    playerEl.style.transition = 'none';
  }
  
  // Notify game to update camera simultaneously
  onMoveStart(targetX, targetY, duration);
  
  // Track move with animation data
  currentTween = {
    startX: startX,
    startY: startY,
    targetX: targetX,
    targetY: targetY,
    duration: duration,
    elapsed: 0
  };
}

function updateTween(deltaTime) {
  if (!currentTween) return;
  
  currentTween.elapsed += deltaTime;
  
  // Calculate progress (0 to 1)
  const progress = Math.min(currentTween.elapsed / currentTween.duration, 1);
  
  // Linear interpolation for visual position
  visualX = currentTween.startX + (currentTween.targetX - currentTween.startX) * progress;
  visualY = currentTween.startY + (currentTween.targetY - currentTween.startY) * progress;
  
  // Update player visual position directly (no CSS transition)
  if (playerEl) {
    playerEl.style.transform = actorTransform(visualX, visualY);
  }
  
  // Movement complete when duration elapsed
  if (progress >= 1) {
    completeMove();
  }
}

function completeMove() {
  const targetX = state.player.x;
  const targetY = state.player.y;
  
  currentTween = null;
  isMoving = false;
  
  // Remove moving class (stops walk animation)
  if (playerEl) {
    playerEl.classList.remove('moving');
  }
  
  // Notify completion
  onMoveComplete(targetX, targetY);
  
  // Try to execute combat intent (attack after arriving in range)
  tryExecuteCombatIntent();
  
  // Check if path complete and should interact
  if (currentPath.length === 0 && interactOnArrival) {
    interactOnArrival = false;
    clearPathMarkers();
    setTimeout(() => onInteract(), 50);
  }
}

// ============================================
// COLLISION
// ============================================
function canMoveTo(x, y) {
  const collision = window.__vetuuCollision;
  if (collision?.canMoveTo) {
    return collision.canMoveTo(state, x, y);
  }
  
  // Fallback
  if (x < 0 || y < 0 || x >= state.map.meta.width || y >= state.map.meta.height) {
    return false;
  }
  
  const row = state.map.ground[y];
  if (!row) return false;
  
  const tileChar = row[x];
  // Look up by character directly (legend keys are strings)
  const tile = state.map.legend.tiles[tileChar];
  return tile?.walkable === true;
}

// ============================================
// KEYBOARD INPUT
// ============================================
// Individual direction key mappings
const DIRECTION_KEYS = {
  'KeyW': { dx: 0, dy: -1 },
  'KeyS': { dx: 0, dy: 1 },
  'KeyA': { dx: -1, dy: 0 },
  'KeyD': { dx: 1, dy: 0 },
  'ArrowUp': { dx: 0, dy: -1 },
  'ArrowDown': { dx: 0, dy: 1 },
  'ArrowLeft': { dx: -1, dy: 0 },
  'ArrowRight': { dx: 1, dy: 0 }
};

/**
 * Calculate combined direction from all held direction keys.
 * Allows diagonal movement by combining two perpendicular directions.
 */
function calculateDirectionFromHeldKeys() {
  let dx = 0;
  let dy = 0;
  
  for (const key of keysHeld) {
    const dir = DIRECTION_KEYS[key];
    if (dir) {
      dx += dir.dx;
      dy += dir.dy;
    }
  }
  
  // Clamp to -1, 0, 1 (handles opposing keys canceling out)
  dx = Math.max(-1, Math.min(1, dx));
  dy = Math.max(-1, Math.min(1, dy));
  
  if (dx === 0 && dy === 0) {
    return null;
  }
  
  return { dx, dy };
}

function handleKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  const code = e.code;
  keysHeld.add(code);
  
  if (DIRECTION_KEYS[code]) {
    e.preventDefault();
    cancelPath(); // Keyboard cancels any pathfinding
    cancelCombatPursuit(); // Cancel move-to-range pursuit, but keep auto-attack for kiting
    // Recalculate direction from all held keys (enables diagonal)
    lastKeyDirection = calculateDirectionFromHeldKeys();
  }
}

function handleKeyUp(e) {
  const code = e.code;
  keysHeld.delete(code);
  
  // Recalculate direction from remaining held keys
  if (DIRECTION_KEYS[code]) {
    lastKeyDirection = calculateDirectionFromHeldKeys();
  }
}

// ============================================
// PATHFINDING
// ============================================
export function createPathTo(targetX, targetY, shouldInteract = false) {
  cancelPath();
  
  if (!state) return false;
  
  const startX = state.player.x;
  const startY = state.player.y;
  
  // Already at destination
  if (startX === targetX && startY === targetY) {
    if (shouldInteract) {
      onInteract();
      // Also trigger onMoveComplete to process pendingInteraction
      onMoveComplete(startX, startY);
    }
    return true;
  }
  
  // Determine actual destination
  let destX = targetX;
  let destY = targetY;
  
  if (shouldInteract) {
    // Path to adjacent tile for interaction
    const adj = findAdjacentWalkable(targetX, targetY, startX, startY);
    if (!adj) return false;
    destX = adj.x;
    destY = adj.y;
    
    // Already adjacent?
    if (Math.abs(targetX - startX) + Math.abs(targetY - startY) <= 1) {
      onInteract();
      // Also trigger onMoveComplete to process pendingInteraction
      onMoveComplete(startX, startY);
      return true;
    }
  } else if (!canMoveTo(destX, destY)) {
    // Find nearest walkable
    const nearest = findNearestWalkable(destX, destY);
    if (!nearest) return false;
    destX = nearest.x;
    destY = nearest.y;
  }
  
  // A* pathfinding
  const path = findPath(startX, startY, destX, destY);
  if (!path || path.length === 0) return false;
  
  currentPath = path;
  interactOnArrival = shouldInteract;
  showPathMarkers(path);
  
  return true;
}

// ============================================
// OPTIMIZED A* PATHFINDING
// ============================================
// Uses binary heap for O(log n) extraction and Map for O(1) lookups

const SQRT2 = Math.SQRT2;
const SQRT2_MINUS_2 = SQRT2 - 2;

// Binary heap operations for priority queue
function heapPush(heap, node) {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].f <= heap[i].f) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  if (heap.length === 0) return null;
  if (heap.length === 1) return heap.pop();
  
  const result = heap[0];
  heap[0] = heap.pop();
  
  let i = 0;
  const len = heap.length;
  while (true) {
    const left = (i << 1) + 1;
    const right = left + 1;
    let smallest = i;
    
    if (left < len && heap[left].f < heap[smallest].f) smallest = left;
    if (right < len && heap[right].f < heap[smallest].f) smallest = right;
    
    if (smallest === i) break;
    [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
    i = smallest;
  }
  
  return result;
}

// Pre-allocated neighbor offsets (avoid object creation in hot loop)
const NEIGHBOR_OFFSETS = [
  { dx: 0, dy: -1, cost: 1 },      // N
  { dx: 0, dy: 1, cost: 1 },       // S
  { dx: -1, dy: 0, cost: 1 },      // W
  { dx: 1, dy: 0, cost: 1 },       // E
  { dx: -1, dy: -1, cost: SQRT2 }, // NW
  { dx: 1, dy: -1, cost: SQRT2 },  // NE
  { dx: -1, dy: 1, cost: SQRT2 },  // SW
  { dx: 1, dy: 1, cost: SQRT2 }    // SE
];

function findPath(startX, startY, endX, endY) {
  // Use numeric keys for O(1) lookups without string allocation
  const mapWidth = state.map.meta.width;
  const toKey = (x, y) => y * mapWidth + x;
  
  const startNode = { x: startX, y: startY, g: 0, h: 0, f: 0, parent: null };
  const openHeap = [startNode];
  const openMap = new Map(); // key -> node (for O(1) lookup)
  const closedSet = new Set();
  
  openMap.set(toKey(startX, startY), startNode);
  
  // Octile distance heuristic (optimal for 8-directional movement)
  const heuristic = (ax, ay) => {
    const dx = Math.abs(endX - ax);
    const dy = Math.abs(endY - ay);
    return dx + dy + SQRT2_MINUS_2 * Math.min(dx, dy);
  };
  
  let iterations = 0;
  const maxIter = 5000;
  
  while (openHeap.length > 0 && iterations < maxIter) {
    iterations++;
    
    // Get node with lowest f score: O(log n) with heap
    const current = heapPop(openHeap);
    const currentKey = toKey(current.x, current.y);
    openMap.delete(currentKey);
    
    // Reached destination
    if (current.x === endX && current.y === endY) {
      const path = [];
      let node = current;
      while (node.parent) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }
    
    closedSet.add(currentKey);
    
    // Check neighbors using pre-allocated offsets
    for (let i = 0; i < 8; i++) {
      const offset = NEIGHBOR_OFFSETS[i];
      const nx = current.x + offset.dx;
      const ny = current.y + offset.dy;
      const nKey = toKey(nx, ny);
      
      if (closedSet.has(nKey)) continue;
      if (!canMoveTo(nx, ny)) continue;
      
      // Check for corner cutting on diagonal moves
      if (offset.dx !== 0 && offset.dy !== 0) {
        if (!canMoveTo(current.x + offset.dx, current.y) || 
            !canMoveTo(current.x, current.y + offset.dy)) {
          continue;
        }
      }
      
      const g = current.g + offset.cost;
      
      const existing = openMap.get(nKey);
      if (existing) {
        // Update if better path found
        if (g < existing.g) {
          existing.g = g;
          existing.f = g + existing.h;
          existing.parent = current;
          // Note: heap property may be violated, but A* still finds optimal path
          // Full heap update would require tracking indices
        }
      } else {
        const h = heuristic(nx, ny);
        const newNode = { x: nx, y: ny, g, h, f: g + h, parent: current };
        heapPush(openHeap, newNode);
        openMap.set(nKey, newNode);
      }
    }
  }
  
  return null;
}

function findAdjacentWalkable(targetX, targetY, fromX, fromY) {
  // Include diagonal adjacent tiles
  const adjacent = [
    // Cardinal
    { x: targetX, y: targetY - 1 },
    { x: targetX, y: targetY + 1 },
    { x: targetX - 1, y: targetY },
    { x: targetX + 1, y: targetY },
    // Diagonal
    { x: targetX - 1, y: targetY - 1 },
    { x: targetX + 1, y: targetY - 1 },
    { x: targetX - 1, y: targetY + 1 },
    { x: targetX + 1, y: targetY + 1 }
  ];
  
  let best = null;
  let bestDist = Infinity;
  
  for (const adj of adjacent) {
    if (canMoveTo(adj.x, adj.y)) {
      // Use actual distance (accounts for diagonal being √2)
      const dx = adj.x - fromX;
      const dy = adj.y - fromY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        best = adj;
      }
    }
  }
  
  return best;
}

function findNearestWalkable(x, y) {
  for (let r = 1; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (canMoveTo(x + dx, y + dy)) {
          return { x: x + dx, y: y + dy };
        }
      }
    }
  }
  return null;
}

// ============================================
// PATH VISUALIZATION
// ============================================
function showPathMarkers(path) {
  clearPathMarkers();
  
  const actorLayer = document.getElementById('actor-layer');
  if (!actorLayer) return;
  
  for (let i = 0; i < path.length; i++) {
    const { x, y } = path[i];
    const marker = document.createElement('div');
    marker.className = 'path-marker';
    marker.style.setProperty('--pos-x', `${x * TILE_SIZE + TILE_SIZE / 2 - 4}px`);
    marker.style.setProperty('--pos-y', `${y * TILE_SIZE + TILE_SIZE / 2 - 4}px`);
    marker.style.setProperty('--marker-opacity', 0.3 + (i / path.length) * 0.5);
    actorLayer.appendChild(marker);
    pathMarkers.push(marker);
  }
}

function removeFirstPathMarker() {
  if (pathMarkers.length > 0) {
    const marker = pathMarkers.shift();
    marker?.remove();
  }
}

function clearPathMarkers() {
  for (const marker of pathMarkers) {
    marker?.remove();
  }
  pathMarkers = [];
}

export function cancelPath() {
  currentPath = [];
  interactOnArrival = false;
  clearPathMarkers();
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
export function setPlayerPosition(x, y, animate = true) {
  if (!playerEl) return;
  
  if (animate && state) {
    state.player.x = x;
    state.player.y = y;
    startMove(x, y, false);
  } else {
    if (state) {
      state.player.x = x;
      state.player.y = y;
    }
    // Update visual position for instant placement
    visualX = x;
    visualY = y;
    // No CSS transition needed - we animate manually
    playerEl.style.transition = 'none';
    playerEl.style.transform = actorTransform(x, y);
  }
}

export function isCurrentlyMoving() {
  return isMoving;
}

// Expose to window for cross-module access (combat intent system)
if (typeof window !== 'undefined') {
  window.__vetuuMovement = {
    isCurrentlyMoving: () => isMoving
  };
}

export function hasActivePath() {
  return currentPath.length > 0;
}

export function getPlayerPosition() {
  return state ? { x: state.player.x, y: state.player.y } : null;
}

// Sprint timer SVG state
let sprintTimerPathLength = null;
let sprintDurationInterval = null;

/**
 * Initialize sprint timer SVG (called once on first use)
 */
function initSprintTimer() {
  const fillPath = document.querySelector('#sprint-timer-svg .sprint-timer-fill');
  if (!fillPath || sprintTimerPathLength) return;
  
  sprintTimerPathLength = fillPath.getTotalLength();
  fillPath.style.strokeDasharray = sprintTimerPathLength;
  fillPath.style.strokeDashoffset = sprintTimerPathLength;
}

/**
 * Update the sprint duration countdown display and overlay
 */
function updateSprintDurationDisplay(remainingMs, totalMs) {
  const sprintSlot = document.querySelector('[data-slot="sprint"]');
  const timerEl = sprintSlot?.querySelector('.cooldown-timer');
  const overlayEl = sprintSlot?.querySelector('.cooldown-overlay');
  
  if (remainingMs <= 0) {
    if (timerEl) timerEl.textContent = '';
    if (overlayEl) overlayEl.style.setProperty('--cooldown-pct', '0');
  } else {
    // Update countdown text
    const seconds = Math.ceil(remainingMs / 1000);
    if (timerEl) timerEl.textContent = seconds;
    
    // Update overlay (percentage remaining)
    const pct = (remainingMs / totalMs) * 100;
    if (overlayEl) overlayEl.style.setProperty('--cooldown-pct', pct);
  }
}

/**
 * Activate sprint buff - increases movement speed by 70% for 8 seconds
 * @param {Function} onComplete - Callback when buff ends (to start cooldown)
 */
export function activateSprintBuff(onComplete) {
  // Clear any existing timeout/interval
  if (sprintBuffTimeout) {
    clearTimeout(sprintBuffTimeout);
  }
  if (sprintDurationInterval) {
    clearInterval(sprintDurationInterval);
  }
  
  sprintBuffActive = true;
  const startTime = Date.now();
  
  // Add visual indicator on player
  if (playerEl) {
    playerEl.classList.add('sprinting');
  }
  
  // Initialize and animate sprint timer SVG
  initSprintTimer();
  const wrapper = document.querySelector('.sprint-slot-wrapper');
  const fillPath = document.querySelector('#sprint-timer-svg .sprint-timer-fill');
  const sprintSlot = document.querySelector('[data-slot="sprint"]');
  
  if (wrapper && fillPath && sprintTimerPathLength) {
    wrapper.classList.add('sprint-active');
    
    // Reset to full (start of animation)
    fillPath.style.transition = 'none';
    fillPath.style.strokeDashoffset = '0';
    
    // Force reflow to ensure transition starts fresh
    fillPath.getBoundingClientRect();
    
    // Animate to empty over the buff duration
    fillPath.style.transition = `stroke-dashoffset ${SPRINT_BUFF_DURATION}ms linear`;
    fillPath.style.strokeDashoffset = sprintTimerPathLength;
  }
  
  // Start duration countdown display (uses same overlay/text as cooldown)
  updateSprintDurationDisplay(SPRINT_BUFF_DURATION, SPRINT_BUFF_DURATION);
  sprintDurationInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = SPRINT_BUFF_DURATION - elapsed;
    updateSprintDurationDisplay(remaining, SPRINT_BUFF_DURATION);
  }, 100);
  
  // Auto-deactivate after duration
  sprintBuffTimeout = setTimeout(() => {
    sprintBuffActive = false;
    sprintBuffTimeout = null;
    
    // Clear countdown interval
    if (sprintDurationInterval) {
      clearInterval(sprintDurationInterval);
      sprintDurationInterval = null;
    }
    
    // Clear duration display
    updateSprintDurationDisplay(0, SPRINT_BUFF_DURATION);
    
    if (playerEl) {
      playerEl.classList.remove('sprinting');
    }
    
    // Remove sprint timer visual
    if (wrapper) {
      wrapper.classList.remove('sprint-active');
    }
    
    // Call completion callback (starts cooldown)
    if (onComplete) {
      onComplete();
    }
  }, SPRINT_BUFF_DURATION);
  
  return true;
}

/**
 * Check if sprint buff is currently active
 */
export function isSprintBuffActive() {
  return sprintBuffActive;
}

