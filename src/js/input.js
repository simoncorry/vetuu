/**
 * VETUU — Input Module
 * Handles mouse, touch, and non-movement keyboard input
 * Movement is delegated to movement.js
 */

import { createPathTo, cancelPath } from './movement.js';
import { cancelCombatEngagement } from './combat.js';

// ============================================
// STATE
// ============================================
let targetCallback = null;

const TILE_SIZE = 24;

// Debounce for weapon toggle (prevents double-fire from multiple event paths)
let lastWeaponToggleAt = 0;
const WEAPON_TOGGLE_DEBOUNCE_MS = 150;

// ============================================
// INITIALIZATION
// ============================================
export function initInput(_onInteract, onTarget, _onSecondary) {
  targetCallback = onTarget || (() => {});

  // Non-movement keyboard
  document.addEventListener('keydown', onKeyDown);

  // Mouse/touch for clicking
  const viewport = document.getElementById('viewport');
  if (viewport) {
    viewport.addEventListener('click', onLeftClick);
    viewport.addEventListener('contextmenu', onRightClick);
    viewport.addEventListener('touchstart', onTouchStart, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd);
  }

  // Action bar click handlers
  initActionBarClicks();

  console.log('Input system initialized');
}

// ============================================
// ACTION BAR CLICK HANDLERS
// ============================================
function initActionBarClicks() {
  // Weapon toggle slot - with debounce to prevent double-fire
  const weaponToggle = document.getElementById('weapon-toggle-slot');
  if (weaponToggle) {
    weaponToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Debounce check using performance.now() as authoritative clock
      const now = performance.now();
      if (now - lastWeaponToggleAt < WEAPON_TOGGLE_DEBOUNCE_MS) {
        return; // Ignore rapid duplicate clicks
      }
      lastWeaponToggleAt = now;
      
      targetCallback('cycleWeapon');
    });
  }

  // Weapon ability slots (1-3)
  document.querySelectorAll('[data-action-type="weapon"]').forEach(slot => {
    slot.addEventListener('click', (e) => {
      e.preventDefault();
      const slotNum = parseInt(slot.dataset.slot, 10);
      if (!isNaN(slotNum)) {
        targetCallback('weaponAbility', slotNum);
      }
    });
  });

  // Sense ability slots (4-6)
  document.querySelectorAll('[data-action-type="sense"]').forEach(slot => {
    slot.addEventListener('click', (e) => {
      e.preventDefault();
      const slotNum = parseInt(slot.dataset.slot, 10);
      if (!isNaN(slotNum) && !slot.disabled) {
        targetCallback('senseAbility', slotNum);
      }
    });
  });

  // Utility slots (sprint, heal)
  document.querySelectorAll('[data-action-type="utility"]').forEach(slot => {
    slot.addEventListener('click', (e) => {
      e.preventDefault();
      const utilityId = slot.dataset.slot;
      if (utilityId) {
        targetCallback('utility', utilityId);
      }
    });
  });
}

// ============================================
// KEYBOARD INPUT (Non-movement keys)
// ============================================
function onKeyDown(e) {
  // Skip if typing in input fields or dialogs are open
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  // Check if dialogue panel is open (for dialogue-specific keys)
  const dialoguePanel = document.getElementById('dialogue-panel');
  const dialogueOpen = dialoguePanel && dialoguePanel.open;

  const code = e.code;

  // Movement keys are handled by movement.js
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
    return; // Let movement.js handle these
  }

  // ============================================
  // WEAPON TOGGLE (~ or Space) - with debounce
  // ============================================
  if (code === 'Backquote' || code === 'Space') {
    e.preventDefault();
    if (!dialogueOpen) {
      // Debounce check using performance.now() as authoritative clock
      const now = performance.now();
      if (now - lastWeaponToggleAt < WEAPON_TOGGLE_DEBOUNCE_MS) {
        return; // Ignore rapid duplicate triggers
      }
      lastWeaponToggleAt = now;
      
      targetCallback('cycleWeapon');
    }
    return;
  }

  // ============================================
  // WEAPON ABILITIES (1, 2, 3) - no Sense cost
  // ============================================
  if (code === 'Digit1') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('weaponAbility', 1); 
    return; 
  }
  if (code === 'Digit2') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('weaponAbility', 2); 
    return; 
  }
  if (code === 'Digit3') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('weaponAbility', 3); 
    return; 
  }

  // ============================================
  // SENSE ABILITIES (4, 5, 6) - spends Sense
  // ============================================
  if (code === 'Digit4') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('senseAbility', 4); // Push
    return; 
  }
  if (code === 'Digit5') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('senseAbility', 5); // Pull
    return; 
  }
  if (code === 'Digit6') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('senseAbility', 6); // Locked until Act 3
    return; 
  }

  // ============================================
  // UTILITY ABILITIES
  // ============================================
  // Sprint (9 primary, E secondary)
  if (code === 'Digit9' || code === 'KeyE') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('utility', 'sprint'); 
    return; 
  }
  // Heal (0 primary, Q secondary)
  if (code === 'Digit0' || code === 'KeyQ') { 
    e.preventDefault(); 
    if (!dialogueOpen) targetCallback('utility', 'heal'); 
    return; 
  }

  // ============================================
  // TAB TARGET
  // ============================================
  if (code === 'Tab') {
    e.preventDefault();
    if (targetCallback) targetCallback('cycle');
    return;
  }

  // ============================================
  // INVENTORY
  // ============================================
  if (code === 'KeyI') {
    e.preventDefault();
    const panel = document.getElementById('inventory-panel');
    if (panel) panel.open ? panel.close() : panel.showModal();
    return;
  }

  // ============================================
  // ESCAPE - Cancel / Close
  // ============================================
  if (code === 'Escape') {
    cancelPath();
    targetCallback('clear');
    document.getElementById('dialogue-panel')?.close?.();
    document.getElementById('inventory-panel')?.close?.();
  }
}

// ============================================
// MOUSE INPUT
// ============================================
let lastClickTime = 0;
let lastClickPos = { x: 0, y: 0 };
const DOUBLE_CLICK_DELAY = 300;
const DOUBLE_CLICK_DISTANCE = 30;

function onLeftClick(e) {
  // Ignore clicks on UI elements
  if (e.target.closest('#hud, #quest-tracker, #action-bar, #player-frame, #target-frame, #minimap-container, #combat-log-container, #controls-hint, #dialogue-panel, #inventory-panel')) {
    return;
  }

  const now = Date.now();
  const clickX = e.clientX;
  const clickY = e.clientY;
  
  // Check for double-click
  const timeSinceLastClick = now - lastClickTime;
  const distFromLastClick = Math.hypot(clickX - lastClickPos.x, clickY - lastClickPos.y);
  
  if (timeSinceLastClick < DOUBLE_CLICK_DELAY && distFromLastClick < DOUBLE_CLICK_DISTANCE) {
    // Double-click detected
    onDoubleClick(clickX, clickY, e.target);
    lastClickTime = 0; // Reset
    return;
  }
  
  lastClickTime = now;
  lastClickPos = { x: clickX, y: clickY };

  const worldPos = screenToWorld(e.clientX, e.clientY);
  if (!worldPos) return;

  const { x, y } = worldPos;
  const state = window.__vetuuState;
  if (!state) return;

  // Check for enemy at click location
  const enemy = findEnemyAt(state, x, y);
  if (enemy) {
    targetCallback('select', enemy);
    return;
  }

  // Check for NPC at click location
  const npc = findNpcAt(state, x, y);
  if (npc) {
    // Select NPC as target (shows in target frame)
    targetCallback('selectNpc', npc);
    // Also path to them for interaction
    createPathTo(x, y, true);
    return;
  }

  // Check for interactable object
  const obj = findObjectAt(state, x, y);
  if (obj?.interact) {
    createPathTo(x, y, true);
    return;
  }

  // Path to empty tile - cancel any combat pursuit
  cancelCombatEngagement();
  createPathTo(x, y, false);
}

function onDoubleClick(clientX, clientY, target) {
  // Ignore clicks on UI elements
  if (target.closest('#hud, #quest-tracker, #action-bar, #player-frame, #target-frame, #minimap-container, #combat-log-container, #controls-hint, #dialogue-panel, #inventory-panel')) {
    return;
  }

  const worldPos = screenToWorld(clientX, clientY);
  const state = window.__vetuuState;
  if (!state) return;
  
  // Check for enemy at click location first
  if (worldPos) {
    const enemy = findEnemyAt(state, worldPos.x, worldPos.y);
    if (enemy && enemy.hp > 0) {
      targetCallback('attack', enemy);
      return;
    }
  }
  
  // No enemy at click - find nearest enemy and attack
  const player = state.player;
  const enemies = state.runtime.activeEnemies.filter(e => e.hp > 0);
  
  if (enemies.length > 0) {
    enemies.sort((a, b) => {
      const distA = Math.hypot(a.x - player.x, a.y - player.y);
      const distB = Math.hypot(b.x - player.x, b.y - player.y);
      return distA - distB;
    });
    targetCallback('attack', enemies[0]);
  }
}

function onRightClick(e) {
  e.preventDefault();

  if (e.target.closest('#hud, #quest-tracker, #action-bar, #player-frame, #target-frame')) {
    return;
  }

  const worldPos = screenToWorld(e.clientX, e.clientY);
  if (!worldPos) {
    cancelPath();
    targetCallback('clear');
    return;
  }

  const { x, y } = worldPos;
  const state = window.__vetuuState;
  if (!state) {
    cancelPath();
    targetCallback('clear');
    return;
  }

  // Check for enemy at right-click location - initiate auto-attack
  const enemy = findEnemyAt(state, x, y);
  if (enemy && enemy.hp > 0) {
    targetCallback('attack', enemy); // New action type for auto-attack
    return;
  }

  // Default: cancel path and clear target
  cancelPath();
  targetCallback('clear');
}

// ============================================
// TOUCH INPUT
// ============================================
let touchStart = null;
let lastTapTime = 0;
let lastTapPos = { x: 0, y: 0 };
const DOUBLE_TAP_DELAY = 300; // ms between taps for double-tap
const DOUBLE_TAP_DISTANCE = 30; // max pixels between taps

function onTouchStart(e) {
  if (e.touches.length === 1) {
    touchStart = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      time: Date.now()
    };
  }
}

function onTouchEnd(e) {
  if (!touchStart) return;

  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  const duration = Date.now() - touchStart.time;

  // Tap detection
  if (duration < 300 && Math.abs(dx) < 20 && Math.abs(dy) < 20) {
    const now = Date.now();
    const tapX = touch.clientX;
    const tapY = touch.clientY;
    
    // Check for double-tap
    const timeSinceLastTap = now - lastTapTime;
    const distFromLastTap = Math.hypot(tapX - lastTapPos.x, tapY - lastTapPos.y);
    
    if (timeSinceLastTap < DOUBLE_TAP_DELAY && distFromLastTap < DOUBLE_TAP_DISTANCE) {
      // Double-tap detected - initiate auto-attack on nearest enemy
      onDoubleTap(tapX, tapY);
      lastTapTime = 0; // Reset to prevent triple-tap
    } else {
      // Single tap - handle normally
      onLeftClick({
        clientX: tapX,
        clientY: tapY,
        target: document.elementFromPoint(tapX, tapY)
      });
      lastTapTime = now;
      lastTapPos = { x: tapX, y: tapY };
    }
  }

  touchStart = null;
}

function onDoubleTap(clientX, clientY) {
  const worldPos = screenToWorld(clientX, clientY);
  const state = window.__vetuuState;
  if (!state) return;
  
  // Check for enemy at tap location first
  if (worldPos) {
    const enemy = findEnemyAt(state, worldPos.x, worldPos.y);
    if (enemy && enemy.hp > 0) {
      targetCallback('attack', enemy);
      return;
    }
  }
  
  // No enemy at tap - find nearest enemy and attack
  const player = state.player;
  const enemies = state.runtime.activeEnemies.filter(e => e.hp > 0);
  
  if (enemies.length > 0) {
    enemies.sort((a, b) => {
      const distA = Math.hypot(a.x - player.x, a.y - player.y);
      const distB = Math.hypot(b.x - player.x, b.y - player.y);
      return distA - distB;
    });
    targetCallback('attack', enemies[0]);
  }
}

// ============================================
// COORDINATE CONVERSION
// ============================================
function screenToWorld(screenX, screenY) {
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  if (!viewport || !world) return null;

  const state = window.__vetuuState;
  if (!state) return null;

  const rect = viewport.getBoundingClientRect();
  const style = window.getComputedStyle(world);
  const matrix = new DOMMatrix(style.transform);
  const camX = matrix.m41;
  const camY = matrix.m42;

  const localX = screenX - rect.left;
  const localY = screenY - rect.top;

  const worldX = Math.floor((localX - camX) / TILE_SIZE);
  const worldY = Math.floor((localY - camY) / TILE_SIZE);

  if (worldX < 0 || worldY < 0 || worldX >= state.map.meta.width || worldY >= state.map.meta.height) {
    return null;
  }

  return { x: worldX, y: worldY };
}

// For minimap clicks
export function worldToScreen(worldX, worldY) {
  return { x: worldX * TILE_SIZE, y: worldY * TILE_SIZE };
}

// ============================================
// ENTITY LOOKUPS
// ============================================
function findEnemyAt(state, x, y) {
  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp > 0 && enemy.x === x && enemy.y === y) {
      return enemy;
    }
  }
  return null;
}

function findNpcAt(state, x, y) {
  return state.entities.npcs.find(n => n.x === x && n.y === y);
}

function findObjectAt(state, x, y) {
  return state.map.objects.find(o => o.x === x && o.y === y);
}

// Re-export for compatibility
export { createPathTo, cancelPath } from './movement.js';
