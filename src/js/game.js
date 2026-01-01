/**
 * VETUU — Drycross Alpha
 * Main game module: state management, initialization, game loop
 */

import { initRenderer, renderWorld, updateCamera, renderActors, renderObjects } from './render.js';
import { initInput } from './input.js';
import { initMovement, createPathTo } from './movement.js';
import { canMoveTo, getObjectAt, getNpcAt } from './collision.js';
import { initFog, revealAround, renderFog, updateFogArea } from './fog.js';
import { initDialogue, showDialogue, isDialogueOpen } from './dialogue.js';
import { initQuests, updateQuestProgress, renderQuestTracker, checkQuestConditions } from './quests.js';
import { initCombat, handleTargeting, renderEnemies, playerSpecial, cycleWeapon, getCurrentWeapon, getWeapons, useAction, checkPendingAttack, checkCorpseReached, isInGhostMode } from './combat.js';
import { initSpawnDirector, getSpawnDebugInfo } from './spawnDirector.js';
import { loadGame, saveGame, saveFlag, loadFlags, hasFlag } from './save.js';
import { expandMap, toExpandedCoords, BASE_CENTER } from './mapGenerator.js';

// ============================================
// GAME STATE
// ============================================
export const state = {
  tick: 0,
  dayPhase: 'day',

  player: {
    x: 56,
    y: 42,
    hp: 100,
    maxHp: 100,
    sense: 20,
    maxSense: 20,
    atk: 5,
    def: 3,
    luck: 1,
    level: 1,
    xp: 0,
    xpToNext: 100,
    inventory: [],
    equipment: { weapon: 'laser_rifle', armor: null, accessory: null }
  },

  flags: {},
  quests: { active: [], complete: [] },

  map: { meta: null, legend: null, ground: [], objects: [], regions: [] },
  entities: { npcs: [], enemies: [], bosses: [] },
  dialogue: { nodes: {}, texts: {} },
  questDefs: [],
  items: [],
  shops: [],

  runtime: {
    isMoving: false,
    currentRegion: null,
    interactTarget: null,
    collectedNodes: new Set(),
    activeEnemies: [],
    spawnedAreas: new Set(),
    defeatedBosses: new Set()
  }
};

// ============================================
// DATA LOADING
// ============================================
async function loadData() {
  const [mapData, entitiesData, dialogueData, questsData, itemsData] = await Promise.all([
    fetch('data/map.json').then(r => r.json()),
    fetch('data/entities.json').then(r => r.json()),
    fetch('data/dialogue.json').then(r => r.json()),
    fetch('data/quests.json').then(r => r.json()),
    fetch('data/items.json').then(r => r.json())
  ]);

  // Expand the map 4x
  const expandedMap = expandMap(mapData);
  const offset = expandedMap.meta.originalOffset;

  state.map.meta = expandedMap.meta;
  state.map.legend = expandedMap.legend;
  state.map.ground = expandedMap.ground;
  state.map.objects = expandedMap.objects;
  state.map.regions = mapData.regions;

  // Translate player start to expanded coordinates
  state.player.x = entitiesData.playerStart.x + offset.x;
  state.player.y = entitiesData.playerStart.y + offset.y;

  // Translate NPC coordinates
  state.entities.npcs = entitiesData.npcs.map(npc => ({
    ...npc,
    x: npc.x + offset.x,
    y: npc.y + offset.y
  }));

  // Translate enemy spawn coordinates
  state.entities.enemies = entitiesData.enemySpawns.map(spawn => ({
    ...spawn,
    center: {
      x: spawn.center.x + offset.x,
      y: spawn.center.y + offset.y
    }
  }));

  // Translate boss coordinates
  state.entities.bosses = entitiesData.bosses.map(boss => ({
    ...boss,
    x: boss.x + offset.x,
    y: boss.y + offset.y
  }));

  state.dialogue.nodes = dialogueData.nodes;
  state.dialogue.texts = dialogueData.texts;

  state.questDefs = questsData.quests;
  state.items = itemsData.items;
  state.shops = itemsData.shops;
}

// ============================================
// XP & LEVELING
// ============================================
const XP_TABLE = [
  0, 100, 220, 360, 520, 700, 900, 1120, 1360, 1620,
  1900, 2200, 2520, 2860, 3220, 3600, 4000, 4420, 4860, 5320,
  5800, 6300, 6820, 7360, 7920
];

export function grantXP(amount) {
  state.player.xp += amount;
  showToast(`+${amount} XP`, 'xp');

  while (state.player.level < 25 && state.player.xp >= state.player.xpToNext) {
    levelUp();
  }

  updateHUD();
  saveGame(state);
}

function levelUp() {
  state.player.level++;
  state.player.xpToNext = XP_TABLE[state.player.level] || 9999;

  state.player.maxHp += 10;
  state.player.hp = state.player.maxHp;
  state.player.maxSense += 2;
  state.player.sense = state.player.maxSense;
  state.player.atk += 1;
  state.player.def += 1;
  if (state.player.level % 5 === 0) state.player.luck += 1;

  showToast(`Level Up! Now Lv. ${state.player.level}`, 'quest');
}

// ============================================
// INVENTORY
// ============================================
export function addItem(itemId, amount = 1) {
  const itemDef = state.items.find(i => i.id === itemId);
  if (!itemDef) return;

  const existing = state.player.inventory.find(i => i.id === itemId);
  if (existing) {
    existing.qty += amount;
  } else {
    state.player.inventory.push({ id: itemId, qty: amount });
  }

  showToast(`+${amount} ${itemDef.name}`, 'item');
  updateQuestProgress(state, 'collect', { itemId, amount });
  saveGame(state);
}

export function removeItem(itemId, amount = 1) {
  const existing = state.player.inventory.find(i => i.id === itemId);
  if (!existing) return false;
  existing.qty -= amount;
  if (existing.qty <= 0) {
    state.player.inventory = state.player.inventory.filter(i => i.id !== itemId);
  }
  saveGame(state);
  return true;
}

export function hasItem(itemId, amount = 1) {
  const existing = state.player.inventory.find(i => i.id === itemId);
  return existing && existing.qty >= amount;
}

export function getItemCount(itemId) {
  const existing = state.player.inventory.find(i => i.id === itemId);
  return existing ? existing.qty : 0;
}

export function equipItem(itemId) {
  const itemDef = state.items.find(i => i.id === itemId);
  if (!itemDef || !hasItem(itemId)) return;

  const slot = itemDef.type;
  if (!['weapon', 'armor', 'accessory'].includes(slot)) return;

  const current = state.player.equipment[slot];
  if (current) {
    const currentDef = state.items.find(i => i.id === current);
    if (currentDef?.mods) {
      if (currentDef.mods.attack) state.player.atk -= currentDef.mods.attack;
      if (currentDef.mods.defense) state.player.def -= currentDef.mods.defense;
      if (currentDef.mods.luck) state.player.luck -= currentDef.mods.luck;
    }
  }

  state.player.equipment[slot] = itemId;
  if (itemDef.mods) {
    if (itemDef.mods.attack) state.player.atk += itemDef.mods.attack;
    if (itemDef.mods.defense) state.player.def += itemDef.mods.defense;
    if (itemDef.mods.luck) state.player.luck += itemDef.mods.luck;
  }

  showToast(`Equipped ${itemDef.name}`, 'item');
  updateHUD();
  saveGame(state);
}

// ============================================
// TOAST
// ============================================
export function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============================================
// HUD UPDATE
// ============================================
export function updateHUD() {
  const p = state.player;

  // Main HUD
  document.getElementById('hp-fill')?.style.setProperty('--pct', (p.hp / p.maxHp) * 100);
  document.getElementById('hp-text').textContent = `${p.hp}/${p.maxHp}`;
  document.getElementById('sense-fill')?.style.setProperty('--pct', (p.sense / p.maxSense) * 100);
  document.getElementById('sense-text').textContent = `${p.sense}/${p.maxSense}`;
  document.getElementById('atk-val').textContent = p.atk;
  document.getElementById('def-val').textContent = p.def;
  document.getElementById('luck-val').textContent = p.luck;
  document.getElementById('level-val').textContent = p.level;

  const xpProgress = p.level >= 25 ? 100 : ((p.xp - (XP_TABLE[p.level - 1] || 0)) / (p.xpToNext - (XP_TABLE[p.level - 1] || 0))) * 100;
  document.getElementById('xp-fill')?.style.setProperty('--pct', Math.max(0, xpProgress));
  document.getElementById('xp-text').textContent = p.level >= 25 ? 'MAX' : `${p.xp}/${p.xpToNext}`;

  // Player frame
  const playerHpFill = document.getElementById('player-hp-fill');
  const playerHpText = document.getElementById('player-hp-text');
  const playerSenseFill = document.getElementById('player-sense-fill');
  const playerSenseText = document.getElementById('player-sense-text');
  const playerFrameLevel = document.getElementById('player-frame-level');

  if (playerHpFill) playerHpFill.style.width = `${(p.hp / p.maxHp) * 100}%`;
  if (playerHpText) playerHpText.textContent = `${p.hp}/${p.maxHp}`;
  if (playerSenseFill) playerSenseFill.style.width = `${(p.sense / p.maxSense) * 100}%`;
  if (playerSenseText) playerSenseText.textContent = `${p.sense}/${p.maxSense}`;
  if (playerFrameLevel) playerFrameLevel.textContent = p.level;

  // Player sprite health bar
  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.style.setProperty('--player-hp-pct', (p.hp / p.maxHp) * 100);
  }

  updateLocation();
  updateMinimap();
}

function updateLocation() {
  const { x, y } = state.player;
  let regionName = 'Wilderness';

  for (const region of state.map.regions) {
    const b = region.bounds;
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      regionName = region.name;
      break;
    }
  }

  state.runtime.currentRegion = regionName;
  document.getElementById('location-name').textContent = regionName;
  document.getElementById('minimap-label').textContent = regionName;
}

// ============================================
// MINIMAP
// ============================================
let minimapScale = 1;

function initMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  const fogCanvas = document.getElementById('minimap-fog');
  const minimap = document.getElementById('minimap');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  minimapScale = canvas.width / state.map.meta.width;

  // Draw terrain
  for (let y = 0; y < state.map.ground.length; y++) {
    const row = state.map.ground[y];
    for (let x = 0; x < row.length; x++) {
      const tileId = parseInt(row[x], 36);
      const tile = state.map.legend.tiles[tileId];
      if (tile) {
        ctx.fillStyle = tile.color;
        ctx.fillRect(x * minimapScale, y * minimapScale, Math.ceil(minimapScale), Math.ceil(minimapScale));
      }
    }
  }

  // Draw regions/POIs
  for (const region of state.map.regions) {
    const b = region.bounds;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(b.x0 * minimapScale, b.y0 * minimapScale, (b.x1 - b.x0) * minimapScale, (b.y1 - b.y0) * minimapScale);
  }

  // Initialize fog canvas
  if (fogCanvas) {
    const fogCtx = fogCanvas.getContext('2d');
    fogCtx.fillStyle = 'rgba(13, 15, 17, 0.95)';
    fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
  }

  // Click-to-move on minimap
  if (minimap) {
    minimap.addEventListener('click', onMinimapClick);
  }

  updateMinimapFog();
}

function onMinimapClick(e) {
  const minimap = document.getElementById('minimap');
  if (!minimap) return;

  const rect = minimap.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  // Convert to world coordinates
  const worldX = Math.floor(clickX / minimapScale);
  const worldY = Math.floor(clickY / minimapScale);

  // Check bounds
  if (worldX < 0 || worldY < 0 || worldX >= state.map.meta.width || worldY >= state.map.meta.height) {
    return;
  }

  // Create path to clicked location
  createPathTo(worldX, worldY, false);
}

function updateMinimap() {
  const playerDot = document.getElementById('minimap-player');
  const canvas = document.getElementById('minimap-canvas');
  if (!playerDot || !canvas) return;

  const x = state.player.x * minimapScale;
  const y = state.player.y * minimapScale;

  playerDot.style.left = `${x}px`;
  playerDot.style.top = `${y}px`;

  updateMinimapFog();
}

function updateMinimapFog() {
  const fogCanvas = document.getElementById('minimap-fog');
  if (!fogCanvas) return;

  const fogCtx = fogCanvas.getContext('2d');
  const revealed = state.runtime.revealedTiles || new Set();

  // Clear revealed areas
  fogCtx.globalCompositeOperation = 'destination-out';
  
  for (const key of revealed) {
    const [x, y] = key.split(',').map(Number);
    fogCtx.fillStyle = 'rgba(255, 255, 255, 1)';
    fogCtx.fillRect(
      x * minimapScale - 0.5,
      y * minimapScale - 0.5,
      Math.ceil(minimapScale) + 1,
      Math.ceil(minimapScale) + 1
    );
  }

  fogCtx.globalCompositeOperation = 'source-over';
}

// Corpse marker on minimap
// Store corpse world coordinates for click-to-path
let corpseWorldX = null;
let corpseWorldY = null;

export function updateMinimapCorpse(x, y) {
  clearMinimapCorpse(); // Remove any existing marker
  
  // Store world coordinates for click handler
  corpseWorldX = x;
  corpseWorldY = y;
  
  const minimap = document.getElementById('minimap');
  if (!minimap) return;
  
  const corpseMarker = document.createElement('div');
  corpseMarker.id = 'minimap-corpse';
  corpseMarker.className = 'minimap-corpse';
  corpseMarker.style.left = `${x * minimapScale}px`;
  corpseMarker.style.top = `${y * minimapScale}px`;
  corpseMarker.textContent = '💀';
  corpseMarker.title = 'Click to path to your corpse';
  
  // Click to path to corpse
  corpseMarker.addEventListener('click', (e) => {
    e.stopPropagation();
    if (corpseWorldX !== null && corpseWorldY !== null) {
      createPathTo(corpseWorldX, corpseWorldY, false);
    }
  });
  
  minimap.appendChild(corpseMarker);
}

export function clearMinimapCorpse() {
  corpseWorldX = null;
  corpseWorldY = null;
  const existing = document.getElementById('minimap-corpse');
  if (existing) {
    existing.remove();
  }
}

// ============================================
// INTERACTION
// ============================================
function checkInteraction() {
  const { x, y } = state.player;
  const directions = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];

  let target = null;
  let targetType = null;

  for (const dir of directions) {
    const npc = getNpcAt(state, x + dir.dx, y + dir.dy);
    if (npc) {
      if (npc.flags?.hidden && !hasFlag(state, 'sela_revealed')) continue;
      if (npc.requires?.flag && !hasFlag(state, npc.requires.flag)) continue;
      target = npc;
      targetType = 'npc';
      break;
    }
  }

  if (!target) {
    for (const dir of directions) {
      const obj = getObjectAt(state, x + dir.dx, y + dir.dy);
      if (obj?.interact) {
        target = obj;
        targetType = 'object';
        break;
      }
    }
  }

  if (!target) {
    const obj = getObjectAt(state, x, y);
    if (obj?.interact) {
      target = obj;
      targetType = 'object';
    }
  }

  const prompt = document.getElementById('interact-prompt');
  const label = document.getElementById('interact-label');

  if (target) {
    state.runtime.interactTarget = { target, type: targetType };
    prompt.classList.remove('hidden');

    if (targetType === 'npc') {
      label.textContent = `Talk to ${target.name}`;
    } else if (target.interact.action === 'collect') {
      label.textContent = 'Collect';
    } else if (target.interact.action === 'read') {
      label.textContent = 'Examine';
    } else {
      label.textContent = 'Interact';
    }
  } else {
    state.runtime.interactTarget = null;
    prompt.classList.add('hidden');
  }
}

export function interact() {
  if (!state.runtime.interactTarget) return;

  const { target, type } = state.runtime.interactTarget;

  if (type === 'npc') {
    showDialogue(state, target.dialogueRoot, target);
    updateQuestProgress(state, 'talk', { entityId: target.id });
    updateQuestProgress(state, 'return', { entityId: target.id });
  } else if (type === 'object') {
    handleObjectInteract(target);
  }
}

function handleObjectInteract(obj) {
  const action = obj.interact;

  switch (action.action) {
    case 'collect': handleCollect(obj); break;
    case 'read': handleRead(obj); break;
    case 'loot': handleLoot(obj); break;
    case 'triggerAct3': handleAct3Trigger(obj); break;
    case 'unlockPath': handleUnlockPath(obj); break;
  }
}

function handleCollect(obj) {
  if (state.runtime.collectedNodes.has(obj.id)) {
    showToast('Already collected', 'error');
    return;
  }

  addItem(obj.interact.itemId, obj.interact.amount || 1);
  state.runtime.collectedNodes.add(obj.id);

  const objEl = document.querySelector(`[data-obj-id="${obj.id}"]`);
  if (objEl) objEl.classList.add('node-collected');

  if (obj.interact.cooldown) {
    setTimeout(() => {
      state.runtime.collectedNodes.delete(obj.id);
      if (objEl) objEl.classList.remove('node-collected');
    }, obj.interact.cooldown * 1000);
  }
}

function handleRead(obj) {
  const text = state.dialogue.texts[obj.interact.textId];
  if (text) showDialogue(state, null, null, text);
}

function handleLoot(obj) {
  showToast('Searched... nothing useful', 'item');
}

function handleAct3Trigger(obj) {
  if (obj.interact.requires?.questComplete) {
    if (!state.quests.complete.includes(obj.interact.requires.questComplete)) {
      showToast('Something must happen first...', 'error');
      return;
    }
  }

  setFlag('act3');
  showToast('The sky darkens. A ship descends.', 'quest');
  spawnAct3Entities();
}

function handleUnlockPath(obj) {
  if (obj.interact.requires?.flag && !hasFlag(state, obj.interact.requires.flag)) {
    showToast('Locked.', 'error');
    return;
  }

  setFlag(obj.interact.flag);
  showToast('Path unlocked.', 'quest');

  document.querySelectorAll('[data-obj-type="act3_blocker"]').forEach(el => el.remove());
  renderObjects(state);
}

function spawnAct3Entities() {
  renderActors(state);
  renderObjects(state);
  renderQuestTracker(state);
  // Act 3 spawns are now handled by the spawn director based on flags
}

// ============================================
// FLAGS
// ============================================
export function setFlag(flag) {
  state.flags[flag] = true;
  saveFlag(flag, true);
  checkQuestConditions(state);
}

export function clearFlag(flag) {
  delete state.flags[flag];
  saveFlag(flag, false);
}

// ============================================
// ENEMY ENCOUNTERS
// ============================================
// Enemy spawning is now handled by the Spawn Director (spawnDirector.js)
// This provides proper zone-based spawning with:
// - Distance rings (safe/frontier/wilderness/danger)
// - Density caps
// - NPE guarantees for new players
// - Proper leashing and de-aggro

// ============================================
// MOVEMENT CALLBACKS
// ============================================
function onMoveComplete(x, y) {
  // Update camera
  updateCamera(state);
  
  // Reveal fog
  revealAround(state, x, y);
  updateFogArea(x, y);
  
  // Check if player reached their corpse (ghost mode)
  if (isInGhostMode()) {
    if (checkCorpseReached()) {
      // Revived at corpse - update UI
      checkInteraction();
      updateHUD();
      return;
    }
  }
  // Enemy spawning is now handled by the Spawn Director on its own tick
  
  // Quest progress
  updateQuestProgress(state, 'reach', { x, y });
  
  // Update UI
  checkInteraction();
  updateHUD();
}

// ============================================
// SECONDARY ACTION
// ============================================
function handleSecondaryAction() {
  playerSpecial();
}

// ============================================
// ACTION BAR SETUP
// ============================================
function initActionBar() {
  // Action slots (1, 2, 3)
  document.querySelectorAll('.action-slot[data-action-key]').forEach(slot => {
    slot.addEventListener('click', () => {
      const key = slot.dataset.actionKey;
      if (key) {
        useAction(key);
      }
    });
  });

  // Weapon cycle button
  document.getElementById('weapon-cycle-btn')?.addEventListener('click', () => {
    cycleWeapon();
    updateActionBarHighlight();
  });

  // Inventory button
  document.querySelector('[data-action="inventory"]')?.addEventListener('click', () => {
    const panel = document.getElementById('inventory-panel');
    if (panel) panel.showModal();
  });

  // Reset button
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all game progress? This cannot be undone.')) {
      hardReset();
    }
  });

  updateActionBarHighlight();
}

function updateActionBarHighlight() {
  const current = getCurrentWeapon();
  const weapons = getWeapons();
  const weapon = weapons[current];

  // Update weapon display
  const weaponName = document.getElementById('current-weapon-name');
  const weaponIcon = document.getElementById('current-weapon-icon');

  if (weaponName && weapon) weaponName.textContent = weapon.name;
  if (weaponIcon && weapon) weaponIcon.textContent = weapon.icon;

  // Update action slot labels based on current weapon
  if (weapon?.actions) {
    weapon.actions.forEach((action, index) => {
      const slot = document.querySelector(`.action-slot[data-action-key="${index + 1}"]`);
      if (slot) {
        const label = slot.querySelector('.slot-label');
        if (label) label.textContent = action.name;
        slot.title = action.name;
      }
    });
  }
}

// ============================================
// HARD RESET
// ============================================
function hardReset() {
  // Clear all localStorage
  localStorage.clear();
  
  // Reload the page
  showToast('Game reset. Reloading...', 'quest');
  setTimeout(() => {
    window.location.reload();
  }, 500);
}

// ============================================
// GAME LOOP
// ============================================
function gameLoop() {
  state.tick++;
  checkPendingAttack(); // Check if player reached attack range
  requestAnimationFrame(gameLoop);
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
  try {
    await loadData();

    const saved = loadGame();
    if (saved) {
      // Check if saved coordinates are valid for current map
      const validX = saved.player.x >= 0 && saved.player.x < state.map.meta.width;
      const validY = saved.player.y >= 0 && saved.player.y < state.map.meta.height;
      
      // Also check if the position is near the expected offset area (to detect old saves)
      const offset = state.map.meta.originalOffset || { x: 0, y: 0 };
      const isOldSave = saved.player.x < offset.x || saved.player.y < offset.y;
      
      if (validX && validY && !isOldSave) {
        Object.assign(state.player, saved.player);
        Object.assign(state.flags, saved.flags);
        Object.assign(state.quests, saved.quests);
        state.runtime.collectedNodes = new Set(saved.collectedNodes || []);
        state.runtime.spawnedAreas = new Set(saved.spawnedAreas || []);
        state.runtime.defeatedBosses = new Set(saved.defeatedBosses || []);
      } else {
        // Old save with invalid coordinates - keep stats but reset position
        console.log('Detected old save format, resetting position to new map');
        const { x, y, ...otherStats } = saved.player;
        Object.assign(state.player, otherStats);
        Object.assign(state.flags, saved.flags);
        Object.assign(state.quests, saved.quests);
        state.runtime.collectedNodes = new Set(saved.collectedNodes || []);
        // Don't restore spawned areas as they have old coordinates
        state.runtime.defeatedBosses = new Set(saved.defeatedBosses || []);
        showToast('Map updated! Position reset to Drycross.', 'item');
      }
    }

    const savedFlags = loadFlags();
    Object.assign(state.flags, savedFlags);

    window.__vetuuState = state;
    window.__vetuuGame = { showToast, grantXP, addItem, updateHUD, equipItem, updateQuestProgress };

    // Load collision module first (needed by movement)
    const collision = await import('./collision.js');
    window.__vetuuCollision = collision;

    // Initialize renderer and render the world FIRST (creates player element)
    initRenderer(state);
    renderWorld(state);
    renderActors(state); // Creates #player element
    renderObjects(state);
    
    // NOW initialize movement (needs #player element to exist)
    initMovement(state, {
      onMoveComplete: onMoveComplete,
      onMoveStart: (x, y, duration) => updateCamera(state, duration), // Update camera at start so both transitions sync
      onInteract: interact
    });
    
    // Initialize input for non-movement keys and mouse
    initInput(interact, handleTargeting, handleSecondaryAction);
    
    initFog(state);
    initDialogue(state);
    initQuests(state);
    initCombat(state);
    initActionBar();

    // Initialize the new spawn director (handles all enemy spawning)
    initSpawnDirector(state);
    
    // Expose debug info for console
    window.__vetuuSpawnDebug = getSpawnDebugInfo;

    renderEnemies(state);
    updateCamera(state);
    revealAround(state, state.player.x, state.player.y);
    renderFog(state);
    initMinimap();
    updateHUD();
    renderQuestTracker(state);
    checkInteraction();

    gameLoop();

    console.log('Vetuu initialized.');
  } catch (err) {
    console.error('Failed to initialize:', err);
    showToast('Failed to load game data', 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { state as gameState };
