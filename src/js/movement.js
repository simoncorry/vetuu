/**
 * VETUU — Movement System
 * Clean, unified movement handling with smooth transitions
 * 
 * ANIMATION RULE: All motion uses CSS transitions/animations for GPU acceleration.
 * JavaScript only sets final positions - CSS handles interpolation.
 * Always use translate3d() for transforms, never translate().
 */

import { tryExecuteCombatIntent, cancelCombatPursuit } from './combat.js';

// ============================================
// CONSTANTS
// ============================================
const TILE_SIZE = 24;
const MOVE_DURATION = 280; // ms per tile - Classic WoW pacing (slower, tactical)
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
    setPlayerPosition(state.player.x, state.player.y, false);
    // Restore CSS transition after initial placement
    requestAnimationFrame(() => {
      if (playerEl) playerEl.style.transition = '';
    });
  }
  
  // Start the movement tick
  lastTickTime = null;
  requestAnimationFrame(movementTick);
  
  console.log('Movement system initialized');
}

// ============================================
// MAIN MOVEMENT TICK
// ============================================
let lastTickTime = null;

function movementTick(timestamp) {
  // Initialize lastTickTime on first frame
  if (lastTickTime === null) {
    lastTickTime = timestamp;
    requestAnimationFrame(movementTick);
    return;
  }
  
  const deltaTime = Math.min(timestamp - lastTickTime, 50); // Cap at 50ms to prevent huge jumps
  lastTickTime = timestamp;
  
  // Process active tween
  if (currentTween) {
    updateTween(deltaTime);
  }
  
  // If not moving, check for new movement input
  if (!isMoving) {
    processMovementInput();
  }
  
  requestAnimationFrame(movementTick);
}

// ============================================
// INPUT PROCESSING
// ============================================
function processMovementInput() {
  // Block movement if dialogue is open
  const dialoguePanel = document.getElementById('dialogue-panel');
  if (dialoguePanel?.open) return;
  
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
function attemptMove(dx, dy) {
  if (isMoving) return false;
  
  // Validate direction
  if (dx === 0 && dy === 0) return false;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  
  const newX = state.player.x + dx;
  const newY = state.player.y + dy;
  
  // Check collision
  if (!canMoveTo(newX, newY)) {
    return false;
  }
  
  // Start movement
  startMove(newX, newY);
  return true;
}

function startMove(targetX, targetY) {
  isMoving = true;
  
  // Check if in ghost mode (corpse run) for 2x speed
  const isGhost = playerEl?.classList.contains('ghost');
  
  // Calculate duration: ghost mode > sprint buff > normal
  let duration = MOVE_DURATION;
  if (isGhost) {
    duration = MOVE_DURATION * GHOST_MULTIPLIER; // 2x faster during corpse run
  } else if (sprintBuffActive) {
    duration = MOVE_DURATION * SPRINT_BUFF_MULTIPLIER; // 70% faster with sprint buff
  }
  
  // Update logical position immediately
  state.player.x = targetX;
  state.player.y = targetY;
  
  // Update CSS transition duration for sprint
  if (playerEl) {
    playerEl.style.transitionDuration = `${duration}ms`;
    // Set final position - CSS transition handles the animation
    playerEl.style.transform = `translate3d(${targetX * TILE_SIZE}px, ${targetY * TILE_SIZE}px, 0)`;
  }
  
  // Notify game to update camera simultaneously (both transitions start together)
  // Pass duration so camera can match player speed
  onMoveStart(targetX, targetY, duration);
  
  // Track move completion via timer (matches CSS transition)
  currentTween = {
    duration: duration,
    elapsed: 0
  };
}

function updateTween(deltaTime) {
  if (!currentTween) return;
  
  // Just track elapsed time - CSS handles the actual animation
  currentTween.elapsed += deltaTime;
  
  // Movement complete when duration elapsed
  if (currentTween.elapsed >= currentTween.duration) {
    completeMove();
  }
}

function completeMove() {
  const targetX = state.player.x;
  const targetY = state.player.y;
  
  currentTween = null;
  isMoving = false;
  
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

function handleKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  const code = e.code;
  keysHeld.add(code);
  
  if (DIRECTION_KEYS[code]) {
    e.preventDefault();
    cancelPath(); // Keyboard cancels any pathfinding
    cancelCombatPursuit(); // Cancel move-to-range pursuit, but keep auto-attack for kiting
    lastKeyDirection = DIRECTION_KEYS[code];
  }
}

function handleKeyUp(e) {
  const code = e.code;
  keysHeld.delete(code);
  
  // Check if any other direction key is still held
  if (DIRECTION_KEYS[code]) {
    lastKeyDirection = null;
    
    for (const key of keysHeld) {
      if (DIRECTION_KEYS[key]) {
        lastKeyDirection = DIRECTION_KEYS[key];
        break;
      }
    }
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
    if (shouldInteract) onInteract();
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

function findPath(startX, startY, endX, endY) {
  const openSet = [{ x: startX, y: startY, g: 0, h: 0, f: 0, parent: null }];
  const closedSet = new Set();
  const heuristic = (ax, ay, bx, by) => Math.abs(bx - ax) + Math.abs(by - ay);
  
  let iterations = 0;
  const maxIter = 5000;
  
  while (openSet.length > 0 && iterations < maxIter) {
    iterations++;
    
    // Get node with lowest f score
    let lowestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].f < openSet[lowestIdx].f) {
        lowestIdx = i;
      }
    }
    const current = openSet.splice(lowestIdx, 1)[0];
    
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
    
    closedSet.add(`${current.x},${current.y}`);
    
    // Check neighbors (4-directional)
    const neighbors = [
      { x: current.x, y: current.y - 1 },
      { x: current.x, y: current.y + 1 },
      { x: current.x - 1, y: current.y },
      { x: current.x + 1, y: current.y }
    ];
    
    for (const n of neighbors) {
      const key = `${n.x},${n.y}`;
      if (closedSet.has(key)) continue;
      if (!canMoveTo(n.x, n.y)) continue;
      
      const g = current.g + 1;
      const h = heuristic(n.x, n.y, endX, endY);
      const f = g + h;
      
      const existing = openSet.find(o => o.x === n.x && o.y === n.y);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = f;
          existing.parent = current;
        }
      } else {
        openSet.push({ x: n.x, y: n.y, g, h, f, parent: current });
      }
    }
  }
  
  return null;
}

function findAdjacentWalkable(targetX, targetY, fromX, fromY) {
  const adjacent = [
    { x: targetX, y: targetY - 1 },
    { x: targetX, y: targetY + 1 },
    { x: targetX - 1, y: targetY },
    { x: targetX + 1, y: targetY }
  ];
  
  let best = null;
  let bestDist = Infinity;
  
  for (const adj of adjacent) {
    if (canMoveTo(adj.x, adj.y)) {
      const d = Math.abs(adj.x - fromX) + Math.abs(adj.y - fromY);
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
    marker.style.left = `${x * TILE_SIZE + TILE_SIZE / 2 - 4}px`;
    marker.style.top = `${y * TILE_SIZE + TILE_SIZE / 2 - 4}px`;
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
    // Disable transition for instant position set
    playerEl.style.transition = 'none';
    playerEl.style.transform = `translate3d(${x * TILE_SIZE}px, ${y * TILE_SIZE}px, 0)`;
    // Force reflow then restore transition
    playerEl.offsetHeight;
    playerEl.style.transition = '';
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
 * Update the sprint duration countdown display
 */
function updateSprintDurationDisplay(remainingMs) {
  const timerEl = document.querySelector('[data-slot="sprint"] .cooldown-timer');
  if (!timerEl) return;
  
  if (remainingMs <= 0) {
    timerEl.textContent = '';
  } else {
    const seconds = Math.ceil(remainingMs / 1000);
    timerEl.textContent = seconds;
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
  
  // Add active class to slot for visual feedback
  if (sprintSlot) {
    sprintSlot.classList.add('buff-active');
  }
  
  // Start duration countdown display
  updateSprintDurationDisplay(SPRINT_BUFF_DURATION);
  sprintDurationInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = SPRINT_BUFF_DURATION - elapsed;
    updateSprintDurationDisplay(remaining);
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
    updateSprintDurationDisplay(0);
    
    if (playerEl) {
      playerEl.classList.remove('sprinting');
    }
    
    // Remove sprint timer visual
    if (wrapper) {
      wrapper.classList.remove('sprint-active');
    }
    
    // Remove active class from slot
    if (sprintSlot) {
      sprintSlot.classList.remove('buff-active');
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

