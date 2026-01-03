/**
 * VETUU — Input Module
 * Handles mouse, touch, and non-movement keyboard input
 * Movement is delegated to movement.js
 */

import { createPathTo, cancelPath } from './movement.js';
import { cancelCombatPursuit } from './combat.js';
import { toggleTorch } from './game.js';
import { TILE_SIZE } from './render.js';
import { 
  toggleCharacterSheet, 
  toggleMinimap, 
  toggleQuestTracker, 
  handleEscape 
} from './ui.js';

// ============================================
// STATE
// ============================================
let targetCallback = null;
let interactCallback = null;

// Debounce for weapon toggle (prevents double-fire from multiple event paths)
let lastWeaponToggleAt = 0;
const WEAPON_TOGGLE_DEBOUNCE_MS = 150;

// Double-click detection
let lastClickTime = 0;
let lastClickX = -1;
let lastClickY = -1;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_DIST = 2; // Tiles tolerance

// ============================================
// INITIALIZATION
// ============================================
export function initInput(onInteract, onTarget, _onSecondary) {
  interactCallback = onInteract || (() => {});
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
  // Sprint (9 primary, R secondary)
  if (code === 'Digit9' || code === 'KeyR') { 
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
  // TORCH TOGGLE (T)
  // ============================================
  if (code === 'KeyT') {
    e.preventDefault();
    if (!dialogueOpen) toggleTorch();
    return;
  }

  // ============================================
  // INTERACT (E) - Move to and interact with current friendly/object target
  // ============================================
  if (code === 'KeyE') {
    e.preventDefault();
    if (!dialogueOpen) {
      // If we have a selected friendly target (NPC or object), move to and interact
      if (targetCallback) {
        targetCallback('interactWithTarget');
      }
      // Also trigger standard adjacency interaction as fallback
      if (interactCallback) interactCallback();
    }
    return;
  }

  // ============================================
  // TAB TARGET (Tab = enemies, Shift+Tab = friendlies + objects)
  // ============================================
  if (code === 'Tab') {
    e.preventDefault();
    if (targetCallback) {
      if (e.shiftKey) {
        targetCallback('cycleFriendly'); // Now includes objects
      } else {
        targetCallback('cycle');
      }
    }
    return;
  }

  // ============================================
  // INVENTORY (I)
  // ============================================
  if (code === 'KeyI') {
    e.preventDefault();
    const panel = document.getElementById('inventory-panel');
    if (panel) panel.open ? panel.close() : panel.showModal();
    return;
  }

  // ============================================
  // CHARACTER SHEET (C)
  // ============================================
  if (code === 'KeyC') {
    e.preventDefault();
    if (!dialogueOpen) {
      toggleCharacterSheet();
    }
    return;
  }

  // ============================================
  // MINIMAP TOGGLE (Ctrl/Cmd + M)
  // ============================================
  if (code === 'KeyM' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    toggleMinimap();
    return;
  }

  // ============================================
  // QUEST TRACKER TOGGLE (Ctrl/Cmd + J)
  // ============================================
  if (code === 'KeyJ' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    toggleQuestTracker();
    return;
  }

  // ============================================
  // ESCAPE - Close UI / Cancel / Settings
  // Priority: dialogues → inventory → character sheet → settings toggle
  // ============================================
  if (code === 'Escape') {
    e.preventDefault();
    cancelPath();
    targetCallback('clear');
    handleEscape();
  }
}

// ============================================
// MOUSE INPUT
// ============================================

/**
 * Check if this click is a double-click on the same tile.
 */
function isDoubleClick(x, y) {
  const now = Date.now();
  const timeDiff = now - lastClickTime;
  const dist = Math.abs(x - lastClickX) + Math.abs(y - lastClickY);
  
  // Update for next check
  lastClickTime = now;
  lastClickX = x;
  lastClickY = y;
  
  return timeDiff < DOUBLE_CLICK_MS && dist <= DOUBLE_CLICK_DIST;
}

function onLeftClick(e, forceDoubleClick = false) {
  // Ignore clicks on UI elements
  if (e.target.closest('#character-sheet, #quest-tracker, #action-bar, #player-frame, #target-frame, #minimap-container, #combat-log-container, #settings-menu, #dialogue-panel, #inventory-panel')) {
    return;
  }

  const worldPos = screenToWorld(e.clientX, e.clientY);
  if (!worldPos) return;

  const { x, y } = worldPos;
  const state = window.__vetuuState;
  if (!state) return;
  
  // Use forced double-click (from double-tap) or check timing-based double-click
  const doubleClick = forceDoubleClick || isDoubleClick(x, y);

  // Check for enemy at click location
  const enemy = findEnemyAt(state, x, y);
  if (enemy) {
    if (doubleClick) {
      // Double-click: move to and auto-attack
      targetCallback('attack', enemy);
    } else {
      // Single-click: just select
      targetCallback('select', enemy);
    }
    return;
  }

  // Check for NPC at click location
  const npc = findNpcAt(state, x, y);
  if (npc) {
    if (doubleClick) {
      // Double-click: move to and interact (use NPC's actual coords, not click coords)
      targetCallback('selectNpc', npc);
      targetCallback('interactWith', { type: 'npc', target: npc, x: npc.x, y: npc.y });
    } else {
      // Single-click: just select (show portrait)
      targetCallback('selectNpc', npc);
    }
    return;
  }

  // Check for interactable object
  const obj = findObjectAt(state, x, y);
  if (obj?.interact) {
    if (doubleClick) {
      // Double-click: move to and interact (use object's actual coords, not click coords)
      targetCallback('selectObject', obj);
      targetCallback('interactWith', { type: 'object', target: obj, x: obj.x, y: obj.y });
    } else {
      // Single-click: just select (show in target frame)
      targetCallback('selectObject', obj);
    }
    return;
  }
  
  // Path to empty tile - cancel move-to-range pursuit, but keep auto-attack for kiting
  cancelCombatPursuit();
  createPathTo(x, y, false);
}

function onRightClick(e) {
  e.preventDefault();

  if (e.target.closest('#character-sheet, #quest-tracker, #action-bar, #player-frame, #target-frame, #minimap-container, #settings-menu')) {
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
    targetCallback('attack', enemy);
    return;
  }

  // Check for NPC at right-click location - move to and interact
  const npc = findNpcAt(state, x, y);
  if (npc) {
    targetCallback('selectNpc', npc);
    targetCallback('interactWith', { type: 'npc', target: npc, x: npc.x, y: npc.y });
    return;
  }

  // Check for interactable object at right-click location - move to and interact
  const obj = findObjectAt(state, x, y);
  if (obj?.interact) {
    targetCallback('selectObject', obj);
    targetCallback('interactWith', { type: 'object', target: obj, x: obj.x, y: obj.y });
    return;
  }

  // Default: cancel path and clear target
  cancelPath();
  targetCallback('clear');
}

// ============================================
// TOUCH INPUT (with double-tap detection)
// ============================================
let touchStart = null;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_DIST = 30; // Pixels tolerance for mobile

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
    const tapDist = Math.abs(touch.clientX - lastTapX) + Math.abs(touch.clientY - lastTapY);
    const isDoubleTap = (now - lastTapTime < DOUBLE_TAP_MS) && (tapDist < DOUBLE_TAP_DIST);
    
    // Pass double-tap flag directly to avoid timing simulation issues
    onLeftClick({
      clientX: touch.clientX,
      clientY: touch.clientY,
      target: document.elementFromPoint(touch.clientX, touch.clientY)
    }, isDoubleTap);
    
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }

  touchStart = null;
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
  
  // Extract scale factor from the matrix (matrix.a = scaleX)
  const scale = matrix.a || 1;
  
  // transform: scale(N) translate3d(-x, -y, 0) results in:
  // m41 = -x * scale, m42 = -y * scale
  const camX = -matrix.m41 / scale;
  const camY = -matrix.m42 / scale;

  // Convert screen position to unscaled world coordinates
  const localX = screenX - rect.left;
  const localY = screenY - rect.top;
  const unscaledX = localX / scale + camX;
  const unscaledY = localY / scale + camY;

  const worldX = Math.floor(unscaledX / TILE_SIZE);
  const worldY = Math.floor(unscaledY / TILE_SIZE);

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
/**
 * Find an enemy at or near the given tile coordinates.
 * Uses a small search radius because:
 * 1. Actor sprites are 32px tall on 24px tiles (8px extends into tile above)
 * 2. Click precision can be imperfect
 * Returns the closest enemy within range.
 */
function findEnemyAt(state, x, y) {
  let closest = null;
  let closestDist = Infinity;
  
  for (const enemy of state.runtime.activeEnemies || []) {
    if (enemy.hp <= 0) continue;
    
    // Check within 1 tile radius (accounts for sprite offset + click imprecision)
    const dx = Math.abs(enemy.x - x);
    const dy = Math.abs(enemy.y - y);
    
    // Also check tile above click (y-1 maps to enemy.y) for sprite offset
    const dyAbove = Math.abs(enemy.y - (y + 1));
    
    if (dx <= 1 && (dy <= 1 || dyAbove <= 1)) {
      const dist = dx + Math.min(dy, dyAbove);
      if (dist < closestDist) {
        closest = enemy;
        closestDist = dist;
      }
    }
  }
  return closest;
}

/**
 * Find an NPC at or near the given tile coordinates.
 * Uses same fuzzy matching as findEnemyAt.
 */
function findNpcAt(state, x, y) {
  let closest = null;
  let closestDist = Infinity;
  
  for (const npc of state.entities.npcs || []) {
    const dx = Math.abs(npc.x - x);
    const dy = Math.abs(npc.y - y);
    const dyAbove = Math.abs(npc.y - (y + 1));
    
    if (dx <= 1 && (dy <= 1 || dyAbove <= 1)) {
      const dist = dx + Math.min(dy, dyAbove);
      if (dist < closestDist) {
        closest = npc;
        closestDist = dist;
      }
    }
  }
  return closest;
}

/**
 * Find an interactable object at the given tile coordinates.
 * Objects don't have sprite offset, so only check exact tile.
 */
function findObjectAt(state, x, y) {
  return state.map.objects.find(o => o.x === x && o.y === y);
}

// Re-export for compatibility
export { createPathTo, cancelPath } from './movement.js';
