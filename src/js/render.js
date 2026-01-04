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
import { mapConfig, getRingVisualization } from './mapConfig.js';

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
  const zoom = matrix.a || ZOOM_FACTOR;
  
  // transform: scale(Z) translate3d(-x, -y, 0) results in:
  // m41 = -x * scale, m42 = -y * scale
  return {
    vw: viewportEl.clientWidth,
    vh: viewportEl.clientHeight,
    camX: -matrix.m41 / zoom,
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

/**
 * Debug: Check actual loaded map state
 * Call from console: VETUU_MAP_DEBUG()
 */
window.VETUU_MAP_DEBUG = function() {
  if (!currentState?.map) {
    console.log('[Map Debug] No map loaded');
    return null;
  }
  
  const meta = currentState.map.meta;
  const ground = currentState.map.ground;
  const player = currentState.player;
  
  console.log('=== MAP DEBUG ===');
  console.log('Meta dimensions:', meta.width, 'x', meta.height);
  console.log('Original offset:', meta.originalOffset);
  console.log('Ground rows:', ground?.length);
  console.log('First row length:', ground?.[0]?.length);
  console.log('');
  console.log('Player position:', player?.x, player?.y);
  console.log('Expected base center:', 56 + (meta.originalOffset?.x || 0), 38 + (meta.originalOffset?.y || 0));
  console.log('');
  console.log('Is player inside map?', 
    player?.x >= 0 && player?.x < meta.width && 
    player?.y >= 0 && player?.y < meta.height);
  
  return {
    meta,
    groundRows: ground?.length,
    groundCols: ground?.[0]?.length,
    player: { x: player?.x, y: player?.y }
  };
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
    // All NPCs start with 'idle' for slower movement (guards remove it when fighting)
    let npcClass = 'actor npc idle';
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

  // Clear only NPCs and bosses, preserve player and enemies
  const existingPlayerEl = document.getElementById('player');
  
  // Remove only NPCs and bosses (not enemies)
  actorLayer.querySelectorAll('.npc, .boss').forEach(el => el.remove());
  
  // Re-add player at the start if it exists (preserve z-order)
  if (existingPlayerEl && !existingPlayerEl.parentElement) {
    actorLayer.insertBefore(existingPlayerEl, actorLayer.firstChild);
  }
  
  // Add new NPCs/bosses from fragment
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

// Camera animation state
let cameraAnim = null;
let currentCamX = 0;
let currentCamY = 0;

/**
 * Tick camera animation - called from main game loop
 * @param {number} timestamp - Current timestamp from performance.now()
 */
export function tickCamera(timestamp) {
  if (!cameraAnim) return;
  
  const { startX, startY, targetX, targetY, startTime, duration } = cameraAnim;
  const elapsed = timestamp - startTime;
  const progress = Math.min(elapsed / duration, 1);
  
  // Linear interpolation (matches CSS linear timing)
  currentCamX = startX + (targetX - startX) * progress;
  currentCamY = startY + (targetY - startY) * progress;
  
  // Apply transform directly (no CSS transition)
  world.style.transform = `scale3d(${ZOOM_FACTOR}, ${ZOOM_FACTOR}, 1) translate3d(${-currentCamX}px, ${-currentCamY}px, 0)`;
  
  if (progress >= 1) {
    cameraAnim = null;
  }
}

export function updateCamera(state, duration = null) {
  if (!viewport || !world) return;
  
  currentState = state;

  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  // Center camera on player (adjusted for zoom)
  const targetX = state.player.x * TILE_SIZE + TILE_SIZE / 2 - (vw / ZOOM_FACTOR) / 2;
  const targetY = state.player.y * TILE_SIZE + TILE_SIZE / 2 - (vh / ZOOM_FACTOR) / 2;

  // Clamp to world bounds
  const worldW = mapWidth * TILE_SIZE;
  const worldH = mapHeight * TILE_SIZE;
  const x = Math.max(0, Math.min(targetX, worldW - (vw / ZOOM_FACTOR)));
  const y = Math.max(0, Math.min(targetY, worldH - (vh / ZOOM_FACTOR)));

  // Instant update (teleport/respawn/initial load)
  if (duration === 0 || duration === null) {
    // Cancel any ongoing animation
    cameraAnim = null;
    currentCamX = x;
    currentCamY = y;
    // Disable transition and set directly
    world.style.transition = 'none';
    world.style.transform = `scale3d(${ZOOM_FACTOR}, ${ZOOM_FACTOR}, 1) translate3d(${-x}px, ${-y}px, 0)`;
    return;
  }

  // Animated update - animation ticked from main game loop
  world.style.transition = 'none';
  
  cameraAnim = {
    startX: currentCamX,
    startY: currentCamY,
    targetX: x,
    targetY: y,
    startTime: performance.now(),
    duration: duration
  };
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

// ============================================
// DEBUG RING OVERLAY
// ============================================
let ringOverlayCanvas = null;
let ringOverlayCtx = null;
let ringOverlayVisible = false;

/**
 * Toggle debug ring overlay showing spawn zone boundaries.
 * Call from console: VETUU_RINGS()
 * Toggles rings on main view, minimap, and fullscreen world map.
 */
window.VETUU_RINGS = function() {
  ringOverlayVisible = !ringOverlayVisible;
  
  if (!ringOverlayCanvas) {
    createRingOverlay();
  }
  
  if (ringOverlayVisible) {
    drawRingOverlay();
    ringOverlayCanvas.style.display = 'block';
    console.log('[Debug] Ring overlay ON - showing spawn zone boundaries');
    console.log('  🟢 Green: SAFE (0-24 tiles)');
    console.log('  🟡 Yellow: FRONTIER (25-42 tiles)');
    console.log('  🟠 Orange: WILDERNESS (43-58 tiles)');
    console.log('  🔴 Red: DANGER (59-68 tiles)');
    console.log('  🟣 Magenta: DEEP (69+ tiles)');
  } else {
    ringOverlayCanvas.style.display = 'none';
    console.log('[Debug] Ring overlay OFF');
  }
  
  // Also toggle on minimap and world map
  import('./minimap.js').then(mod => {
    if (mod.toggleMinimapRings) {
      // Force to match main overlay state
      const minimapState = mod.toggleMinimapRings();
      if (minimapState !== ringOverlayVisible) {
        mod.toggleMinimapRings();
      }
    }
  }).catch(() => {});
  
  import('./worldmap.js').then(mod => {
    if (mod.toggleWorldMapRings) {
      // Force to match main overlay state
      const worldmapState = mod.toggleWorldMapRings();
      if (worldmapState !== ringOverlayVisible) {
        mod.toggleWorldMapRings();
      }
    }
  }).catch(() => {});
  
  return ringOverlayVisible;
};

function createRingOverlay() {
  const groundLayer = document.getElementById('ground-layer');
  if (!groundLayer) return;
  
  ringOverlayCanvas = document.createElement('canvas');
  ringOverlayCanvas.id = 'ring-debug-overlay';
  ringOverlayCanvas.width = mapWidth * TILE_SIZE;
  ringOverlayCanvas.height = mapHeight * TILE_SIZE;
  ringOverlayCanvas.style.cssText = 'position: absolute; top: 0; left: 0; pointer-events: none; z-index: 10;';
  ringOverlayCanvas.style.display = 'none';
  
  groundLayer.appendChild(ringOverlayCanvas);
  ringOverlayCtx = ringOverlayCanvas.getContext('2d');
}

function drawRingOverlay() {
  if (!ringOverlayCtx || !currentState) return;
  
  // Get base center from mapConfig (single source of truth)
  const baseCenterTileX = mapConfig.baseCenter.x;
  const baseCenterTileY = mapConfig.baseCenter.y;
  
  // Convert to canvas pixels (center of the tile, not top-left corner)
  const baseCenterX = baseCenterTileX * TILE_SIZE + TILE_SIZE / 2;
  const baseCenterY = baseCenterTileY * TILE_SIZE + TILE_SIZE / 2;
  
  // Debug info (only log once per toggle)
  console.log('[Ring Debug] Map:', mapConfig.width, 'x', mapConfig.height);
  console.log('[Ring Debug] Base center tile:', baseCenterTileX, baseCenterTileY);
  console.log('[Ring Debug] Base center px:', baseCenterX, baseCenterY);
  
  // Ring boundaries from mapConfig (auto-scaled based on map size)
  const rings = getRingVisualization();
  
  // Clear canvas
  ringOverlayCtx.clearRect(0, 0, ringOverlayCanvas.width, ringOverlayCanvas.height);
  
  // Draw each ring boundary
  for (const ring of rings) {
    const radiusPx = ring.max * TILE_SIZE;
    
    // Draw circle
    ringOverlayCtx.beginPath();
    ringOverlayCtx.arc(baseCenterX, baseCenterY, radiusPx, 0, Math.PI * 2);
    ringOverlayCtx.strokeStyle = ring.color;
    ringOverlayCtx.lineWidth = 2;
    ringOverlayCtx.setLineDash([10, 10]);
    ringOverlayCtx.stroke();
    
    // Draw label
    ringOverlayCtx.setLineDash([]);
    ringOverlayCtx.font = 'bold 14px monospace';
    ringOverlayCtx.fillStyle = ring.color;
    ringOverlayCtx.strokeStyle = '#000';
    ringOverlayCtx.lineWidth = 3;
    
    // Position label at top of circle
    const labelX = baseCenterX;
    const labelY = baseCenterY - radiusPx + 20;
    
    ringOverlayCtx.strokeText(ring.name, labelX - 30, labelY);
    ringOverlayCtx.fillText(ring.name, labelX - 30, labelY);
    
    // Distance label
    const distLabel = `${ring.max} tiles`;
    ringOverlayCtx.strokeText(distLabel, labelX - 25, labelY + 14);
    ringOverlayCtx.fillText(distLabel, labelX - 25, labelY + 14);
  }
  
  // Draw base center marker
  ringOverlayCtx.beginPath();
  ringOverlayCtx.arc(baseCenterX, baseCenterY, 8, 0, Math.PI * 2);
  ringOverlayCtx.fillStyle = '#ffffff';
  ringOverlayCtx.fill();
  ringOverlayCtx.strokeStyle = '#000';
  ringOverlayCtx.lineWidth = 2;
  ringOverlayCtx.setLineDash([]);
  ringOverlayCtx.stroke();
  
  // Cross-hair at center
  ringOverlayCtx.beginPath();
  ringOverlayCtx.moveTo(baseCenterX - 15, baseCenterY);
  ringOverlayCtx.lineTo(baseCenterX + 15, baseCenterY);
  ringOverlayCtx.moveTo(baseCenterX, baseCenterY - 15);
  ringOverlayCtx.lineTo(baseCenterX, baseCenterY + 15);
  ringOverlayCtx.strokeStyle = '#ff0000';
  ringOverlayCtx.lineWidth = 2;
  ringOverlayCtx.stroke();
  
  const offset = mapConfig.offset;
  
  // Draw ORIGINAL MAP footprint (the 200x140 source map area)
  const originalMap = {
    minX: offset.x * TILE_SIZE,
    maxX: (offset.x + mapConfig.originalWidth) * TILE_SIZE,
    minY: offset.y * TILE_SIZE,
    maxY: (offset.y + mapConfig.originalHeight) * TILE_SIZE
  };
  
  ringOverlayCtx.beginPath();
  ringOverlayCtx.rect(
    originalMap.minX,
    originalMap.minY,
    originalMap.maxX - originalMap.minX,
    originalMap.maxY - originalMap.minY
  );
  ringOverlayCtx.fillStyle = 'rgba(255, 165, 0, 0.1)';  // Orange tint
  ringOverlayCtx.fill();
  ringOverlayCtx.strokeStyle = '#ffa500';  // Orange
  ringOverlayCtx.lineWidth = 3;
  ringOverlayCtx.setLineDash([15, 10]);
  ringOverlayCtx.stroke();
  
  // Label
  ringOverlayCtx.setLineDash([]);
  ringOverlayCtx.font = 'bold 14px monospace';
  ringOverlayCtx.fillStyle = '#ffa500';
  ringOverlayCtx.strokeStyle = '#000';
  ringOverlayCtx.lineWidth = 2;
  ringOverlayCtx.strokeText('ORIGINAL MAP (200x140)', originalMap.minX + 10, originalMap.minY - 10);
  ringOverlayCtx.fillText('ORIGINAL MAP (200x140)', originalMap.minX + 10, originalMap.minY - 10);
  
  // Draw BASE WALLS footprint (inner walled area)
  // Original wall coords: x 43-93, y 49-87 (after crop)
  const baseWalls = {
    minX: (43 + offset.x) * TILE_SIZE,
    maxX: (93 + offset.x) * TILE_SIZE,
    minY: (49 + offset.y) * TILE_SIZE,
    maxY: (87 + offset.y) * TILE_SIZE
  };
  
  // Debug: verify center alignment
  const wallCenterX = (43 + 93) / 2 + offset.x;  // Should be 68 + 132 = 200
  const wallCenterY = (49 + 87) / 2 + offset.y;  // Should be 68 + 132 = 200
  console.log('[Ring Debug] Wall center (tiles):', wallCenterX, wallCenterY);
  console.log('[Ring Debug] Base center from config:', mapConfig.baseCenter.x, mapConfig.baseCenter.y);
  console.log('[Ring Debug] Match:', wallCenterX === mapConfig.baseCenter.x && wallCenterY === mapConfig.baseCenter.y);
  
  // Draw semi-transparent fill
  ringOverlayCtx.beginPath();
  ringOverlayCtx.rect(
    baseWalls.minX,
    baseWalls.minY,
    baseWalls.maxX - baseWalls.minX,
    baseWalls.maxY - baseWalls.minY
  );
  ringOverlayCtx.fillStyle = 'rgba(0, 255, 255, 0.15)';  // Cyan with transparency
  ringOverlayCtx.fill();
  
  // Draw thick border
  ringOverlayCtx.strokeStyle = '#00ffff';  // Cyan
  ringOverlayCtx.lineWidth = 5;
  ringOverlayCtx.setLineDash([]);
  ringOverlayCtx.stroke();
  
  // Label the base footprint
  ringOverlayCtx.font = 'bold 16px monospace';
  ringOverlayCtx.fillStyle = '#00ffff';
  ringOverlayCtx.strokeStyle = '#000';
  ringOverlayCtx.lineWidth = 3;
  ringOverlayCtx.strokeText('BASE WALLS', baseWalls.minX + 10, baseWalls.minY - 10);
  ringOverlayCtx.fillText('BASE WALLS', baseWalls.minX + 10, baseWalls.minY - 10);
}
