/**
 * VETUU — Render Module
 * Canvas-based tile rendering + camera control for large maps
 * 
 * ANIMATION RULE: All motion uses CSS transitions/animations for GPU acceleration.
 * JavaScript only sets final positions - CSS handles interpolation.
 * Always use translate3d() for transforms, never translate().
 */

import { hasFlag } from './save.js';
import { getNpcQuestMarker } from './quests.js';
import { SPRITES } from './sprites.js';
import { isRevealed } from './fog.js';

// ============================================
// RENDERING CONSTANTS (exported for use across modules)
// ============================================
export const TILE_SIZE = 24;          // Logical tile size (matches sprite/map data)
export const ZOOM_FACTOR = 1.5;       // Uniform scale for world + actors
const SPRITE_HEIGHT = 32;             // Character sprites are taller than tiles

/**
 * Generate transform string for actor positioning
 * Offset Y by (SPRITE_HEIGHT - TILE_SIZE) so feet align with tile bottom
 */
export function actorTransform(x, y) {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE - (SPRITE_HEIGHT - TILE_SIZE); // -8px offset
  return `translate3d(${px}px, ${py}px, 0)`;
}

// ============================================
// VIEWPORT & VISIBILITY HELPERS
// ============================================

/**
 * Get current viewport info including zoom and camera position.
 * Used for visibility calculations across modules.
 * 
 * @returns {{ vw: number, vh: number, camX: number, camY: number, zoom: number } | null}
 */
export function getViewportInfo() {
  const viewportEl = document.getElementById('viewport');
  const worldEl = document.getElementById('world');
  if (!viewportEl || !worldEl) return null;
  
  const style = window.getComputedStyle(worldEl);
  const matrix = new DOMMatrix(style.transform);
  const zoom = matrix.a || ZOOM_FACTOR; // Scale factor from matrix, fallback to constant
  
  // transform: scale(Z) translate3d(-x, -y, 0) results in:
  // m41 = -x * scale, m42 = -y * scale
  return {
    vw: viewportEl.clientWidth,
    vh: viewportEl.clientHeight,
    camX: -matrix.m41 / zoom, // Camera offset in logical pixels
    camY: -matrix.m42 / zoom,
    zoom
  };
}

/**
 * Check if an actor (enemy, NPC, etc.) is visible to the player.
 * Checks both fog reveal status and viewport bounds.
 * 
 * @param {object} actor - Any entity with x, y coordinates
 * @returns {boolean} True if actor is visible
 */
export function isActorVisible(actor) {
  // Must not be in fog
  if (!isRevealed(actor.x, actor.y)) {
    return false;
  }
  
  // Get viewport info
  const vp = getViewportInfo();
  if (!vp) return true; // Fallback to visible if no viewport
  
  const { vw, vh, camX, camY, zoom } = vp;
  
  // Calculate actor position in screen pixels
  const screenX = (actor.x * TILE_SIZE - camX) * zoom;
  const screenY = (actor.y * TILE_SIZE - camY) * zoom;
  
  // Buffer accounts for tile size (in screen pixels)
  const buffer = TILE_SIZE * zoom;
  
  return screenX >= -buffer && 
         screenX <= vw + buffer && 
         screenY >= -buffer && 
         screenY <= vh + buffer;
}

// ============================================
// DEBUG HELPER
// ============================================

/**
 * Debug helper for UI/visibility issues.
 * Call from console: VETUU_UI_DEBUG()
 */
window.VETUU_UI_DEBUG = function() {
  const vp = getViewportInfo();
  if (!vp) {
    console.log('[UI Debug] Viewport not available');
    return;
  }
  
  console.log('[UI Debug] Constants:', { TILE_SIZE, ZOOM_FACTOR });
  console.log('[UI Debug] Viewport:', vp);
  
  // Sample actor rect (player)
  const playerEl = document.getElementById('player');
  if (playerEl) {
    const rect = playerEl.getBoundingClientRect();
    console.log('[UI Debug] Player screen rect:', rect);
    console.log('[UI Debug] Player computed style:', {
      transform: getComputedStyle(playerEl).transform,
      zIndex: getComputedStyle(playerEl).zIndex
    });
  }
  
  // Check stacking context
  const actors = document.querySelectorAll('.actor');
  console.log(`[UI Debug] ${actors.length} actors in DOM`);
  
  return { TILE_SIZE, ZOOM_FACTOR, viewport: vp };
};

let viewport = null;
let world = null;
let groundCanvas = null;
let groundCtx = null;
let objectLayer = null;
let actorLayer = null;

let mapWidth = 0;
let mapHeight = 0;
let currentState = null;

// ============================================
// INITIALIZATION
// ============================================
export function initRenderer(state) {
  viewport = document.getElementById('viewport');
  world = document.getElementById('world');
  objectLayer = document.getElementById('object-layer');
  actorLayer = document.getElementById('actor-layer');

  mapWidth = state.map.meta.width;
  mapHeight = state.map.meta.height;
  currentState = state;

  // Set CSS variables for map dimensions
  document.documentElement.style.setProperty('--map-width', mapWidth);
  document.documentElement.style.setProperty('--map-height', mapHeight);
  // Use the zoomed tile size for CSS (logical size, scaled by transform)
  document.documentElement.style.setProperty('--tile-size', `${TILE_SIZE}px`);
  // Actor scale is handled via actorTransform() function

  // Create ground canvas
  const groundLayer = document.getElementById('ground-layer');
  groundCanvas = document.createElement('canvas');
  groundCanvas.id = 'ground-canvas';
  groundCanvas.width = mapWidth * TILE_SIZE;
  groundCanvas.height = mapHeight * TILE_SIZE;
  groundCanvas.style.cssText = 'position: absolute; top: 0; left: 0;';
  
  groundLayer.innerHTML = '';
  groundLayer.appendChild(groundCanvas);
  groundCtx = groundCanvas.getContext('2d');

  // Set world dimensions
  world.style.width = `${mapWidth * TILE_SIZE}px`;
  world.style.height = `${mapHeight * TILE_SIZE}px`;
}

// ============================================
// GROUND RENDERING (Canvas-based)
// ============================================
export function renderWorld(state) {
  const { ground, legend } = state.map;
  currentState = state;

  if (!groundCtx) return;

  // Clear canvas
  groundCtx.clearRect(0, 0, groundCanvas.width, groundCanvas.height);

  // Draw ground tiles (full map, rendered once)
  for (let y = 0; y < ground.length; y++) {
    const row = ground[y];
    for (let x = 0; x < row.length; x++) {
      const tileChar = row[x];
      // Look up by character directly (legend keys are strings)
      const tileDef = legend.tiles[tileChar];

      if (tileDef) {
        groundCtx.fillStyle = tileDef.color;
        groundCtx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }
}

// ============================================
// OBJECT RENDERING (DOM - sparse objects only)
// ============================================
export function renderObjects(state) {
  const { objects, legend } = state.map;
  const fragment = document.createDocumentFragment();

  // Only render objects that are within reasonable bounds
  // and not the procedural border objects (too many)
  let renderedCount = 0;
  const maxObjects = 2000; // Limit to prevent performance issues

  for (const obj of objects) {
    // Skip border objects (they're just for collision)
    if (obj.id?.startsWith('border_')) continue;
    
    // Limit total rendered objects
    if (renderedCount >= maxObjects) break;

    // Check visibility requirements
    if (obj.requires?.flagNot && hasFlag(state, obj.requires.flagNot)) {
      continue;
    }
    if (obj.requires?.flag && !hasFlag(state, obj.requires.flag)) {
      continue;
    }

    const objDef = legend.objects[obj.type];
    if (!objDef) continue;

    const el = document.createElement('div');
    el.className = 'object';
    el.style.setProperty('--pos-x', `${obj.x * TILE_SIZE}px`);
    el.style.setProperty('--pos-y', `${obj.y * TILE_SIZE}px`);
    el.style.setProperty('--obj-color', objDef.color);
    el.dataset.objId = obj.id;
    el.dataset.objType = obj.type;

    if (obj.interact) {
      el.dataset.interactable = 'true';
    }

    // Check if collected
    if (state.runtime.collectedNodes.has(obj.id)) {
      el.classList.add('node-collected');
    }

    fragment.appendChild(el);
    renderedCount++;
  }

  objectLayer.innerHTML = '';
  objectLayer.appendChild(fragment);
}

// ============================================
// ACTOR RENDERING
// ============================================

/**
 * Create shadow and sprite child elements for actor
 * Shadow must be added first to render behind sprite
 */
function createActorChildren(parent) {
  const shadow = document.createElement('div');
  shadow.className = 'shadow';
  parent.appendChild(shadow);
  
  const sprite = document.createElement('div');
  sprite.className = 'sprite';
  parent.appendChild(sprite);
}

export function renderActors(state) {
  const fragment = document.createDocumentFragment();

  // Check if player element already exists (preserve it to keep movement.js reference valid)
  let existingPlayer = document.getElementById('player');
  
  if (!existingPlayer) {
    // Only create player on first render
    const player = document.createElement('div');
    player.id = 'player';
    player.className = 'actor';
    player.style.transition = 'none'; // Prevent transition on initial placement
    player.style.transform = actorTransform(state.player.x, state.player.y);
    player.style.setProperty('--sprite-idle', `url('${SPRITES.actor.idle}')`);
    createActorChildren(player);

    fragment.appendChild(player);
  }

  // NPCs
  for (const npc of state.entities.npcs) {
    // Check visibility requirements
    if (npc.requires?.flag && !hasFlag(state, npc.requires.flag)) {
      continue;
    }

    const el = document.createElement('div');
    // Add role-based classes
    let npcClass = 'actor npc';
    if (npc.isGuard) npcClass += ' guard';
    if (npc.isMedic) npcClass += ' medic';
    el.className = npcClass;
    
    el.style.transform = actorTransform(npc.x, npc.y);
    el.style.setProperty('--sprite-idle', `url('${SPRITES.actor.idle}')`);
    createActorChildren(el);
    el.dataset.npcId = npc.id;
    el.dataset.name = npc.name;

    // Hidden NPCs
    if (npc.flags?.hidden) {
      el.dataset.hidden = 'true';
    }

    // Tooltip for special NPCs
    if (npc.isGuard) {
      el.title = `${npc.name} (Lv.${npc.level})`;
    } else if (npc.isMedic) {
      el.title = `${npc.name} - Field Medic`;
    }

    // Quest markers
    const questForNpc = findQuestForNpc(state, npc.id);
    if (questForNpc) {
      if (questForNpc.status === 'available') {
        el.dataset.quest = 'available';
      } else if (questForNpc.status === 'return') {
        el.dataset.quest = 'return';
      }
    }

    fragment.appendChild(el);
  }

  // Bosses (visible indicator)
  for (const boss of state.entities.bosses) {
    if (boss.requires?.flag && !hasFlag(state, boss.requires.flag)) {
      continue;
    }
    if (state.runtime.defeatedBosses.has(boss.id)) {
      continue;
    }

    const el = document.createElement('div');
    el.className = 'actor boss';
    el.style.transform = actorTransform(boss.x, boss.y);
    el.style.setProperty('--sprite-idle', `url('${SPRITES.actor.idle}')`);
    createActorChildren(el);
    el.dataset.bossId = boss.id;
    el.dataset.name = boss.name;
    fragment.appendChild(el);
  }

  // Clear NPCs but preserve existing player element
  const existingPlayerEl = document.getElementById('player');
  actorLayer.innerHTML = '';
  
  // Re-add existing player if it was preserved
  if (existingPlayerEl) {
    actorLayer.appendChild(existingPlayerEl);
  }
  
  actorLayer.appendChild(fragment);
}

function findQuestForNpc(state, npcId) {
  // Use the quest system's marker logic
  const marker = getNpcQuestMarker(state, npcId);
  
  if (marker === 'completable') {
    return { status: 'return' };
  }
  if (marker === 'available') {
    return { status: 'available' };
  }
  if (marker === 'in-progress') {
    return { status: 'in-progress' };
  }
  
  return null;
}

// ============================================
// CAMERA CONTROL
// ============================================
export function updateCamera(state, duration = null) {
  if (!viewport || !world) return;
  
  currentState = state;

  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  // Center camera on player (adjusted for zoom)
  // We calculate in logical pixels (24px grid)
  // The viewport center in logical pixels is (vw / ZOOM) / 2
  const targetX = state.player.x * TILE_SIZE + TILE_SIZE / 2 - (vw / ZOOM_FACTOR) / 2;
  const targetY = state.player.y * TILE_SIZE + TILE_SIZE / 2 - (vh / ZOOM_FACTOR) / 2;

  // Clamp to world bounds
  const worldW = mapWidth * TILE_SIZE;
  const worldH = mapHeight * TILE_SIZE;

  // Ensure camera doesn't show out of bounds (adjusted for logical viewport size)
  const x = Math.max(0, Math.min(targetX, worldW - (vw / ZOOM_FACTOR)));
  const y = Math.max(0, Math.min(targetY, worldH - (vh / ZOOM_FACTOR)));

  // Sync camera transition duration with player movement (for ghost mode, sprint, etc)
  if (duration !== null) {
    world.style.transitionDuration = `${duration}ms`;
  }

  // Apply Scale AND Translate
  // translate3d moves the layer in logical pixels
  // scale magnifies the result
  world.style.transform = `scale(${ZOOM_FACTOR}) translate3d(${-x}px, ${-y}px, 0)`;
  world.style.transformOrigin = 'top left'; // Important!
}

// ============================================
// PATH RENDERING
// ============================================
export function renderPath(path) {
  clearPath();

  if (!path || path.length === 0) return;

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < path.length; i++) {
    const { x, y } = path[i];
    const marker = document.createElement('div');
    marker.className = 'path-marker';
    marker.style.setProperty('--pos-x', `${x * TILE_SIZE + TILE_SIZE / 2 - 3}px`);
    marker.style.setProperty('--pos-y', `${y * TILE_SIZE + TILE_SIZE / 2 - 3}px`);
    marker.style.setProperty('--marker-opacity', 0.3 + (i / path.length) * 0.5);
    fragment.appendChild(marker);
  }

  actorLayer.appendChild(fragment);
}

export function clearPath() {
  actorLayer.querySelectorAll('.path-marker').forEach(el => el.remove());
}
