/**
 * VETUU — Drycross Alpha
 * Main game module: state management, initialization, game loop
 */

import { initRenderer, renderWorld, updateCamera, renderActors, renderObjects, actorTransform } from './render.js';
import { initInput } from './input.js';
import { initMovement, createPathTo } from './movement.js';
import { getObjectAt, getNpcAt, buildSpatialIndex, canMoveTo, updateNpcPosition } from './collision.js';
import { initFog, revealAround, renderFog, updateFogArea } from './fog.js';
import { initDialogue, showDialogue } from './dialogue.js';
import { initQuests, updateQuestProgress, renderQuestTracker, checkQuestConditions } from './quests.js';
import { initCombat, handleTargeting, renderEnemies, playerSpecial, checkPendingAttack, checkCorpseReached, isInGhostMode } from './combat.js';
import { initSpawnDirector, getSpawnDebugInfo } from './spawnDirector.js';
import { loadGame, saveGame, saveFlag, loadFlags, hasFlag } from './save.js';
import { expandMap } from './mapGenerator.js';
import { getMaxHP, getHPPercent, setMaxHP, normalizeHealthKeys, clampHP } from './entityCompat.js';
import { initDayCycle, updateDayCycle, getTimeOfDay, getNightIntensity, isDeepNight, formatTimeOfDay } from './time.js';
import { cssVar } from './utils.js';

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
    maxHP: 100,
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
// XP & LEVELING - Level Cap 50
// ============================================
const LEVEL_CAP = 50;

/**
 * Generate XP required to reach each level.
 * Curve: xpToNext(level) = round(80 + level² × 6 + level × 20)
 * 
 * This creates a progression where:
 * - Early levels (1-10): Fast, ~100-300 XP each
 * - Mid levels (10-25): Moderate, ~300-800 XP each
 * - Late levels (25-40): Slow, ~900-1400 XP each
 * - Endgame (40-50): Grind, ~1500-2000 XP each
 * 
 * Total XP to 50: ~42,000 (a real campaign, not an afternoon)
 */
function generateXPTable() {
  const table = [0]; // Level 1 starts at 0 cumulative XP
  let cumulative = 0;
  
  for (let level = 1; level <= LEVEL_CAP; level++) {
    // XP needed for this level → next level
    const xpForLevel = Math.round(80 + (level * level) * 6 + level * 20);
    cumulative += xpForLevel;
    table.push(cumulative);
  }
  
  return table;
}

const XP_TABLE = generateXPTable();

/**
 * Get XP required to reach a specific level (cumulative).
 */
export function getXPForLevel(level) {
  if (level < 1) return 0;
  if (level > LEVEL_CAP) return XP_TABLE[LEVEL_CAP];
  return XP_TABLE[level] || 0;
}

/**
 * Get XP needed from current level to next level.
 */
export function getXPToNextLevel(level) {
  if (level >= LEVEL_CAP) return 0;
  return (XP_TABLE[level + 1] || 0) - (XP_TABLE[level] || 0);
}

export function grantXP(amount) {
  state.player.xp += amount;
  showToast(`+${amount} XP`, 'xp');

  while (state.player.level < LEVEL_CAP && state.player.xp >= state.player.xpToNext) {
    levelUp();
  }

  updateHUD();
  saveGame(state);
}

/**
 * Level up the player with new stat scaling for 50-level progression.
 * 
 * Stat gains per level (gentler to prevent inflation):
 * - HP: +6 per level (was +10)
 * - Sense: +1 per level (was +2)
 * - ATK: +0.5 per level (accumulated, +1 every 2 levels)
 * - DEF: +0.5 per level (accumulated, +1 every 2 levels)
 * - Luck: +1 every 5 levels (unchanged)
 * 
 * At level 50:
 * - HP: 100 + 49*6 = 394 (was 100 + 24*10 = 340 at 25)
 * - ATK: 5 + 24 = 29 (was 5 + 24 = 29 at 25)
 * - DEF: 3 + 24 = 27 (was 3 + 24 = 27 at 25)
 */
function levelUp() {
  const oldLevel = state.player.level;
  state.player.level++;
  const newLevel = state.player.level;
  
  // Update XP threshold
  state.player.xpToNext = XP_TABLE[newLevel + 1] || XP_TABLE[LEVEL_CAP];

  // HP: +6 per level
  const newMaxHP = getMaxHP(state.player) + 6;
  setMaxHP(state.player, newMaxHP);
  state.player.hp = newMaxHP;
  
  // Sense: +1 per level (slower than before)
  state.player.maxSense += 1;
  state.player.sense = state.player.maxSense;
  
  // ATK/DEF: +1 every 2 levels (half rate)
  // Use floor division to get accumulated bonuses
  if (newLevel % 2 === 0) {
    state.player.atk += 1;
    state.player.def += 1;
  }
  
  // Luck: +1 every 5 levels
  if (newLevel % 5 === 0) {
    state.player.luck += 1;
  }

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
  const maxHP = getMaxHP(p);
  const hpPct = getHPPercent(p);
  const sensePct = p.maxSense > 0 ? (p.sense / p.maxSense) * 100 : 0;

  // Main HUD
  document.getElementById('hp-fill')?.style.setProperty('--pct', hpPct);
  document.getElementById('hp-text').textContent = `${p.hp}/${maxHP}`;
  document.getElementById('sense-fill')?.style.setProperty('--pct', sensePct);
  document.getElementById('sense-text').textContent = `${p.sense}/${p.maxSense}`;
  document.getElementById('atk-val').textContent = p.atk;
  document.getElementById('def-val').textContent = p.def;
  document.getElementById('luck-val').textContent = p.luck;
  document.getElementById('level-val').textContent = p.level;

  // XP progress calculation - works with generated XP table
  const isMaxLevel = p.level >= LEVEL_CAP;
  const currentLevelXP = XP_TABLE[p.level] || 0;       // XP needed to reach current level
  const nextLevelXP = XP_TABLE[p.level + 1] || currentLevelXP; // XP needed to reach next level
  const xpIntoLevel = p.xp - currentLevelXP;          // XP earned since reaching this level
  const xpNeededForLevel = nextLevelXP - currentLevelXP; // XP needed for this level
  const xpProgress = isMaxLevel ? 100 : (xpNeededForLevel > 0 ? (xpIntoLevel / xpNeededForLevel) * 100 : 100);
  
  document.getElementById('xp-fill')?.style.setProperty('--pct', Math.max(0, Math.min(100, xpProgress)));
  document.getElementById('xp-text').textContent = isMaxLevel ? 'MAX' : `${p.xp}/${nextLevelXP}`;

  // WoW-style XP bar (bottom bar)
  const xpBarFill = document.getElementById('xp-bar-fill');
  const xpBarLevel = document.getElementById('xp-bar-level');
  const xpBarProgress = document.getElementById('xp-bar-progress');
  if (xpBarFill) xpBarFill.style.setProperty('--xp-pct', Math.max(0, Math.min(100, xpProgress)));
  if (xpBarLevel) xpBarLevel.textContent = `Lv.${p.level}`;
  if (xpBarProgress) {
    xpBarProgress.textContent = isMaxLevel ? 'MAX LEVEL' : `${xpIntoLevel} / ${xpNeededForLevel} XP`;
  }

  // Player frame
  const playerHpFill = document.getElementById('player-hp-fill');
  const playerHpText = document.getElementById('player-hp-text');
  const playerSenseFill = document.getElementById('player-sense-fill');
  const playerSenseText = document.getElementById('player-sense-text');
  const playerFrameLevel = document.getElementById('player-frame-level');

  if (playerHpFill) playerHpFill.style.setProperty('--hp-pct', hpPct);
  if (playerHpText) playerHpText.textContent = `${p.hp}/${maxHP}`;
  if (playerSenseFill) playerSenseFill.style.setProperty('--sense-pct', sensePct);
  if (playerSenseText) playerSenseText.textContent = `${p.sense}/${p.maxSense}`;
  if (playerFrameLevel) playerFrameLevel.textContent = p.level;

  // Player sprite health bar
  const playerEl = document.getElementById('player');
  if (playerEl) {
    playerEl.style.setProperty('--player-hp-pct', hpPct);
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
      const tileChar = row[x];
      // Look up by character directly (legend keys are strings)
      const tile = state.map.legend.tiles[tileChar];
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

  // Use transform for GPU-accelerated positioning (includes -50% centering)
  playerDot.style.transform = `translate3d(calc(${x}px - 50%), calc(${y}px - 50%), 0)`;

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
  // Use transform for GPU-accelerated positioning
  corpseMarker.style.transform = `translate3d(calc(${x * minimapScale}px - 50%), calc(${y * minimapScale}px - 50%), 0)`;
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

function handleLoot(_obj) {
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
  // Weapon toggle slot is handled by input.js via initActionBarClicks()
  // cycleWeapon() in combat.js already calls updateWeaponToggleSlot() for UI updates

  // Note: Other action slots (weapon/sense/utility abilities) are handled by input.js
  // via initActionBarClicks() which reads data-slot and data-action-type attributes

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

  // NOTE: Action bar UI is already initialized by combat.js updateActionBar()
  // which is called during initCombat() before initActionBar().
  // No need for duplicate updateActionBarHighlight() here.
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
// ============================================
// CANVAS-BASED LIGHTING SYSTEM
// ============================================
let lightCanvas = null;
let lightCtx = null;
let staticLights = [];
let lightingTileSize = 24;
let cameraX = 0;
let cameraY = 0;

// Torch position interpolation for smooth movement
let torchAnim = {
  startX: 0,
  startY: 0,
  targetX: 0,
  targetY: 0,
  startTime: 0,
  duration: 200,
  currentX: 0,
  currentY: 0
};

// Torch on/off state (T key to toggle)
let torchEnabled = true;

/**
 * Toggle player torch on/off
 * @returns {boolean} New torch state
 */
export function toggleTorch() {
  torchEnabled = !torchEnabled;
  const torch = document.getElementById('player-torch');
  if (torch) {
    torch.style.display = torchEnabled ? 'block' : 'none';
  }
  console.log(`[Torch] ${torchEnabled ? 'ON' : 'OFF'}`);
  return torchEnabled;
}

/**
 * Check if torch is enabled
 */
export function isTorchEnabled() {
  return torchEnabled;
}

/**
 * Check if a position is illuminated by any light source (lamp or player torch)
 * Used for NPC sight range calculations
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @returns {boolean} True if position is within a light source
 */
export function isPositionIlluminated(x, y) {
  // Convert to pixel coordinates
  const px = (x + 0.5) * lightingTileSize;
  const py = (y + 0.5) * lightingTileSize;
  
  // Check player torch (if enabled)
  if (torchEnabled && state?.player) {
    const playerPx = (state.player.x + 0.5) * lightingTileSize;
    const playerPy = (state.player.y + 0.5) * lightingTileSize;
    const torchRadius = 7.2 * lightingTileSize * 1.15; // Mid layer radius
    const distToPlayer = Math.hypot(px - playerPx, py - playerPy);
    if (distToPlayer <= torchRadius) {
      return true;
    }
  }
  
  // Check static lights (lamp posts)
  for (const light of staticLights) {
    const distToLight = Math.hypot(px - light.x, py - light.y);
    const effectiveRadius = light.radius * 1.15; // Mid layer radius
    if (distToLight <= effectiveRadius) {
      return true;
    }
  }
  
  return false;
}

function startTorchMovement(targetX, targetY, duration) {
  torchAnim.startX = torchAnim.currentX;
  torchAnim.startY = torchAnim.currentY;
  torchAnim.targetX = (targetX + 0.5) * lightingTileSize;
  torchAnim.targetY = (targetY + 0.5) * lightingTileSize;
  torchAnim.startTime = performance.now();
  torchAnim.duration = duration;
}

function updateTorchPosition() {
  const now = performance.now();
  const elapsed = now - torchAnim.startTime;
  const t = Math.min(1, elapsed / torchAnim.duration);
  
  // Linear interpolation (matches CSS transition linear)
  torchAnim.currentX = torchAnim.startX + (torchAnim.targetX - torchAnim.startX) * t;
  torchAnim.currentY = torchAnim.startY + (torchAnim.targetY - torchAnim.startY) * t;
}

function initLightingCanvas(gameState) {
  const world = document.getElementById('world');
  if (!world) return;
  
  // Use global TILE_SIZE (24) to match renderer
  lightingTileSize = 24; 
  const width = gameState.map.meta.width * lightingTileSize;
  const height = gameState.map.meta.height * lightingTileSize;
  
  // Create lighting canvas
  lightCanvas = document.createElement('canvas');
  lightCanvas.id = 'lighting-canvas';
  lightCanvas.width = width;
  lightCanvas.height = height;
  lightCanvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${width}px;
    height: ${height}px;
    pointer-events: none;
    z-index: 15;
    transform: translate3d(0, 0, 0);
    will-change: contents;
    contain: strict;
  `;
  
  // Insert after fog layer
  const fogLayer = document.getElementById('fog-layer');
  if (fogLayer && fogLayer.nextSibling) {
    world.insertBefore(lightCanvas, fogLayer.nextSibling);
  } else {
    world.appendChild(lightCanvas);
  }
  
  lightCtx = lightCanvas.getContext('2d');
  
  // Collect static lights (lamp posts)
  staticLights = gameState.map.objects
    .filter(obj => obj.type === 'lamp' && obj.light)
    .map(obj => ({
      x: (obj.x + 0.5) * lightingTileSize,
      y: (obj.y + 0.5) * lightingTileSize,
      radius: (obj.light.radius || 6) * lightingTileSize,
      color: obj.light.color || cssVar('--light-lamp'),
      intensity: obj.light.intensity || 0.8
    }));
  
  // Initialize torch position
  torchAnim.currentX = (state.player.x + 0.5) * lightingTileSize;
  torchAnim.currentY = (state.player.y + 0.5) * lightingTileSize;
  torchAnim.targetX = torchAnim.currentX;
  torchAnim.targetY = torchAnim.currentY;
  
  // Create DOM-based player torch (follows player with CSS transitions)
  createPlayerTorch();
  
  console.log(`[Lighting] Canvas initialized, ${staticLights.length} static lights`);
}

// DOM torch provides subtle warm color tint (canvas does actual darkness-cutting)
function createPlayerTorch() {
  const world = document.getElementById('world');
  if (!world) return;
  
  const torchSize = 5 * lightingTileSize;
  
  // Subtle warm glow overlay - purely aesthetic color tint
  const torch = document.createElement('div');
  torch.id = 'player-torch';
  torch.style.cssText = `
    position: absolute;
    width: ${torchSize}px;
    height: ${torchSize}px;
    pointer-events: none;
    opacity: 0;
    z-index: 16;
    transition: transform var(--move-duration, 200ms) linear, opacity 0.1s linear;
    will-change: transform, opacity;
    backface-visibility: hidden;
    contain: layout style paint;
    border-radius: 50%;
    background: radial-gradient(
      ellipse 50% 55% at 50% 50%,
      rgba(255, 220, 180, 0.08) 0%,
      rgba(255, 200, 150, 0.03) 50%,
      transparent 100%
    );
    mix-blend-mode: overlay;
    filter: blur(4px);
  `;
  
  world.appendChild(torch);
  syncTorchPosition();
}

// Sync torch position with player
function syncTorchPosition() {
  const torch = document.getElementById('player-torch');
  if (!torch || !state.player) return;
  
  const torchSize = 5 * lightingTileSize;
  const halfTorch = torchSize / 2;
  const halfTile = lightingTileSize / 2;
  
  const x = state.player.x * lightingTileSize + halfTile - halfTorch;
  const y = state.player.y * lightingTileSize + halfTile - halfTorch;
  
  torch.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

// Update torch visibility
function updatePlayerTorch(nightIntensity) {
  const torch = document.getElementById('player-torch');
  if (torch) {
    torch.style.opacity = nightIntensity > 0.1 ? (nightIntensity * 0.8).toFixed(3) : '0';
  }
}

function updateLighting() {
  if (!lightCtx || !lightCanvas) return;
  
  // Use time module's night intensity (handles new transition schedule)
  const nightIntensity = getNightIntensity();
  
  // Update DOM-based player torch
  updatePlayerTorch(nightIntensity);
  
  // Skip canvas rendering if it's basically daytime
  if (nightIntensity < 0.05) {
    lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
    return;
  }
  
  // Get viewport info for culling
  const viewport = document.getElementById('viewport');
  const viewWidth = viewport?.clientWidth || 800;
  const viewHeight = viewport?.clientHeight || 600;
  
  // Calculate camera position (same logic as render.js)
  const playerCenterX = state.player.x * lightingTileSize + lightingTileSize / 2;
  const playerCenterY = state.player.y * lightingTileSize + lightingTileSize / 2;
  cameraX = Math.max(0, Math.min(playerCenterX - viewWidth / 2, lightCanvas.width - viewWidth));
  cameraY = Math.max(0, Math.min(playerCenterY - viewHeight / 2, lightCanvas.height - viewHeight));
  
  // Calculate visible area with margin
  const margin = 200;
  const visibleLeft = cameraX - margin;
  const visibleRight = cameraX + viewWidth + margin;
  const visibleTop = cameraY - margin;
  const visibleBottom = cameraY + viewHeight + margin;
  
  // Clear only visible portion for performance
  lightCtx.clearRect(
    Math.max(0, visibleLeft),
    Math.max(0, visibleTop),
    Math.min(lightCanvas.width, visibleRight - visibleLeft),
    Math.min(lightCanvas.height, visibleBottom - visibleTop)
  );
  
  // Fill visible area with darkness
  lightCtx.fillStyle = `rgba(10, 15, 30, ${nightIntensity})`;
  lightCtx.fillRect(
    Math.max(0, visibleLeft),
    Math.max(0, visibleTop),
    Math.min(lightCanvas.width, visibleRight - visibleLeft),
    Math.min(lightCanvas.height, visibleBottom - visibleTop)
  );
  
  // Cut out light circles using destination-out
  lightCtx.globalCompositeOperation = 'destination-out';
  
  // Draw static lights with 3-layer natural diffusion (like torch)
  for (const light of staticLights) {
    // Cull lights outside visible area (use largest layer radius)
    const maxRadius = light.radius * 1.3;
    if (light.x < visibleLeft - maxRadius || 
        light.x > visibleRight + maxRadius ||
        light.y < visibleTop - maxRadius || 
        light.y > visibleBottom + maxRadius) {
      continue;
    }
    
    // Lamp posts: slightly dimmer than torch, cooler color temp
    const baseIntensity = Math.min(1, nightIntensity * light.intensity * 0.9);
    
    // Sci-fi LED behavior: electronic hum + occasional energy surges
    const seed = (light.x * 7 + light.y * 13) % 100;
    const now = Date.now();
    
    // Steady electronic hum (different frequency per lamp for variety)
    const humFreq = 0.003 + (seed % 20) * 0.0001; // Slight freq variation
    const humPhase = seed * 0.5;
    const hum = Math.sin(now * humFreq + humPhase) * 0.08; // ±8% brightness variation
    
    // Energy surge: brief brightness spike every ~10-20 seconds per lamp
    const surgeInterval = 10000 + (seed * 100); // 10-20s based on seed
    const surgeCycle = (now + seed * 1000) % surgeInterval;
    const surgeWindow = 150; // 150ms surge duration
    const isSurging = surgeCycle < surgeWindow;
    const surge = isSurging ? Math.sin((surgeCycle / surgeWindow) * Math.PI) * 0.25 : 0; // Up to +25% brightness
    
    // Combine effects
    const intensity = Math.min(1, baseIntensity * (1 + hum + surge));
    const flicker = 1 + hum * 0.1; // Slight size variation with hum
    
    // Seeded offsets for consistent asymmetry
    const offsetX1 = (seed % 10 - 5) * 0.02 * light.radius;
    const offsetY1 = ((seed * 3) % 10 - 5) * 0.02 * light.radius;
    const offsetX2 = ((seed * 7) % 10 - 5) * 0.03 * light.radius;
    const offsetY2 = ((seed * 11) % 10 - 5) * 0.03 * light.radius;
    
    // Layer 1: Outer ambient glow (largest, softest) - matches torch
    const outerRadius = light.radius * 1.5 * flicker;
    const outerGradient = lightCtx.createRadialGradient(
      light.x + offsetX2, light.y + offsetY2, 0,
      light.x + offsetX2, light.y + offsetY2, outerRadius
    );
    outerGradient.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.3})`);
    outerGradient.addColorStop(0.4, `rgba(255, 255, 255, ${intensity * 0.15})`);
    outerGradient.addColorStop(0.7, `rgba(255, 255, 255, ${intensity * 0.05})`);
    outerGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = outerGradient;
    lightCtx.beginPath();
    lightCtx.arc(light.x + offsetX2, light.y + offsetY2, outerRadius, 0, Math.PI * 2);
    lightCtx.fill();
    
    // Layer 2: Mid diffusion - matches torch
    const midRadius = light.radius * 1.15 * flicker;
    const midGradient = lightCtx.createRadialGradient(
      light.x + offsetX1, light.y + offsetY1, 0,
      light.x + offsetX1, light.y + offsetY1, midRadius
    );
    midGradient.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.5})`);
    midGradient.addColorStop(0.3, `rgba(255, 255, 255, ${intensity * 0.3})`);
    midGradient.addColorStop(0.6, `rgba(255, 255, 255, ${intensity * 0.1})`);
    midGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = midGradient;
    lightCtx.beginPath();
    lightCtx.arc(light.x + offsetX1, light.y + offsetY1, midRadius, 0, Math.PI * 2);
    lightCtx.fill();
    
    // Layer 3: Core - dimmer than torch, wider spread for infrastructure feel
    const coreRadius = light.radius * 0.8; // Slightly wider core
    const coreGradient = lightCtx.createRadialGradient(
      light.x, light.y, 0,
      light.x, light.y, coreRadius
    );
    coreGradient.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.75})`);
    coreGradient.addColorStop(0.25, `rgba(255, 255, 255, ${intensity * 0.5})`);
    coreGradient.addColorStop(0.55, `rgba(255, 255, 255, ${intensity * 0.2})`);
    coreGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = coreGradient;
    lightCtx.beginPath();
    lightCtx.arc(light.x, light.y, coreRadius, 0, Math.PI * 2);
    lightCtx.fill();
  }
  
  // Draw player torch on canvas (only if enabled)
  if (torchEnabled) {
    // Use interpolated position for smooth movement
    updateTorchPosition();
    const playerX = torchAnim.currentX;
    const playerY = torchAnim.currentY;
    const torchBaseRadius = 7.2 * lightingTileSize;
    const now = Date.now();
    
    // Player torch: steady electronic hum (well-maintained equipment)
    const hum = Math.sin(now * 0.004) * 0.05;
    const torchIntensity = Math.min(1, nightIntensity * 1.2 * (1 + hum));
    
    // Slight size variation synced with hum
    const flicker = 1 + Math.sin(now * 0.004) * 0.015;
    
    // Layer 1: Outer ambient (largest, softest)
    const torchOuterRadius = torchBaseRadius * 1.5 * flicker;
    const torchOuterGradient = lightCtx.createRadialGradient(
      playerX - 3, playerY + 2, 0,
      playerX - 3, playerY + 2, torchOuterRadius
    );
    torchOuterGradient.addColorStop(0, `rgba(255, 255, 255, ${torchIntensity * 0.3})`);
    torchOuterGradient.addColorStop(0.4, `rgba(255, 255, 255, ${torchIntensity * 0.15})`);
    torchOuterGradient.addColorStop(0.7, `rgba(255, 255, 255, ${torchIntensity * 0.05})`);
    torchOuterGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = torchOuterGradient;
    lightCtx.beginPath();
    lightCtx.arc(playerX - 2, playerY + 1, torchOuterRadius, 0, Math.PI * 2);
    lightCtx.fill();
    
    // Layer 2: Mid diffusion
    const torchMidRadius = torchBaseRadius * 1.15 * flicker;
    const torchMidGradient = lightCtx.createRadialGradient(
      playerX + 2, playerY - 2, 0,
      playerX + 2, playerY - 2, torchMidRadius
    );
    torchMidGradient.addColorStop(0, `rgba(255, 255, 255, ${torchIntensity * 0.5})`);
    torchMidGradient.addColorStop(0.3, `rgba(255, 255, 255, ${torchIntensity * 0.3})`);
    torchMidGradient.addColorStop(0.6, `rgba(255, 255, 255, ${torchIntensity * 0.1})`);
    torchMidGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = torchMidGradient;
    lightCtx.beginPath();
    lightCtx.arc(playerX + 2, playerY - 2, torchMidRadius, 0, Math.PI * 2);
    lightCtx.fill();
    
    // Layer 3: Core bright center - this is the main illumination
    const torchCoreRadius = torchBaseRadius * 0.7;
    const torchCoreGradient = lightCtx.createRadialGradient(
      playerX, playerY, 0,
      playerX, playerY, torchCoreRadius
    );
    torchCoreGradient.addColorStop(0, `rgba(255, 255, 255, ${torchIntensity * 0.95})`);
    torchCoreGradient.addColorStop(0.2, `rgba(255, 255, 255, ${torchIntensity * 0.7})`);
    torchCoreGradient.addColorStop(0.5, `rgba(255, 255, 255, ${torchIntensity * 0.3})`);
    torchCoreGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    lightCtx.fillStyle = torchCoreGradient;
    lightCtx.beginPath();
    lightCtx.arc(playerX, playerY, torchCoreRadius, 0, Math.PI * 2);
    lightCtx.fill();
  }
  
  // Reset composite operation
  lightCtx.globalCompositeOperation = 'source-over';
}

function gameLoop() {
  state.tick++;
  checkPendingAttack(); // Check if player reached attack range
  
  // Guard patrol tick (every ~60 frames = ~1 second)
  if (state.tick % 60 === 0) {
    tickGuardPatrol();
  }
  
  // Update day/night cycle
  updateDayCycle();
  
  // Update canvas lighting every frame for smooth torch movement
  updateLighting();
  
  requestAnimationFrame(gameLoop);
}

// ============================================
// GUARD PATROL SYSTEM
// ============================================
const GUARD_PATROL_INTERVAL = 4000; // Move every 4 seconds (slower patrol)
const guardLastMove = new Map();

function tickGuardPatrol() {
  const now = Date.now();
  
  for (const npc of state.entities.npcs) {
    if (!npc.patrol || !npc.isGuard) continue;
    
    // Check if enough time has passed since last move
    const lastMove = guardLastMove.get(npc.id) || 0;
    if (now - lastMove < GUARD_PATROL_INTERVAL) continue;
    
    // Random chance to move (50%)
    if (Math.random() > 0.5) continue;
    
    // Store original position if not set
    if (npc.homeX === undefined) {
      npc.homeX = npc.x;
      npc.homeY = npc.y;
    }
    
    const radius = npc.patrolRadius || 1;
    
    // Pick a random direction within patrol area
    const dx = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
    const dy = Math.floor(Math.random() * 3) - 1;
    
    const newX = npc.x + dx;
    const newY = npc.y + dy;
    
    // Check if within patrol radius of home
    if (Math.abs(newX - npc.homeX) > radius || Math.abs(newY - npc.homeY) > radius) {
      continue;
    }
    
    // Check if tile is walkable and not occupied
    if (!canMoveTo(state, newX, newY)) continue;
    if (newX === state.player.x && newY === state.player.y) continue;
    
    // Move the guard
    const oldX = npc.x;
    const oldY = npc.y;
    npc.x = newX;
    npc.y = newY;
    guardLastMove.set(npc.id, now);
    
    // Update spatial index
    updateNpcPosition(npc, oldX, oldY, newX, newY);
    
    // Update visual position (CSS handles the smooth transition)
    const npcEl = document.querySelector(`[data-npc-id="${npc.id}"]`);
    if (npcEl) {
      // Use idle speed for patrol (half normal speed = 560ms)
      npcEl.classList.add('idle');
      npcEl.style.transform = actorTransform(newX, newY);
      
      // Add moving class for walk animation
      npcEl.classList.add('moving');
      clearTimeout(npc._moveTimeout);
      npc._moveTimeout = setTimeout(() => {
        npcEl.classList.remove('moving');
      }, 560); // Match idle transition duration
    }
  }
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
        const { x: _x, y: _y, ...otherStats } = saved.player;
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

    // Normalize player health keys (maxHP/maxHp consistency)
    normalizeHealthKeys(state.player);
    clampHP(state.player);

    window.__vetuuState = state;
    window.__vetuuGame = { showToast, grantXP, addItem, updateHUD, equipItem, updateQuestProgress };

    // Load collision module first (needed by movement)
    const collision = await import('./collision.js');
    window.__vetuuCollision = collision;

    // Build spatial index for O(1) collision lookups
    buildSpatialIndex(state);
    
    // Initialize renderer and render the world FIRST (creates player element)
    initRenderer(state);
    renderWorld(state);
    renderActors(state); // Creates #player element
    renderObjects(state);
    
    // NOW initialize movement (needs #player element to exist)
    initMovement(state, {
      onMoveComplete: onMoveComplete,
      onMoveStart: (x, y, duration) => {
        updateCamera(state, duration); // Update camera at start so both transitions sync
        syncTorchPosition(); // Sync DOM torch position
        startTorchMovement(x, y, duration); // Start canvas torch interpolation
      },
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
    
    // Initialize canvas-based lighting system
    initLightingCanvas(state);
    
    // Initialize day/night cycle (start at morning)
    initDayCycle(0.35);
    
    initMinimap();
    updateHUD();
    renderQuestTracker(state);
    checkInteraction();

    gameLoop();

    // Sync XP bar width with action bar
    syncXpBarWidth();
    window.addEventListener('resize', syncXpBarWidth);

    console.log('Vetuu initialized.');
  } catch (err) {
    console.error('Failed to initialize:', err);
    showToast('Failed to load game data', 'error');
  }
}

// Sync XP bar width to match action bar
function syncXpBarWidth() {
  const actionBar = document.getElementById('action-bar');
  const xpBarContainer = document.getElementById('xp-bar-container');
  if (actionBar && xpBarContainer) {
    const width = actionBar.offsetWidth;
    xpBarContainer.style.setProperty('--action-bar-width', `${width}px`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { state as gameState };
