/**
 * VETUU — World Map Module
 * Fullscreen strategic world map with fog, POIs, and waypoints
 * 
 * Design principles (from lighting revert learnings):
 * - Fixed overlay (NOT inside #world camera transforms)
 * - Screen-fixed canvases + dirty-flag renders
 * - No always-on RAF - render only when needed
 * - Viewport-sized canvases (bounded to visible tiles)
 * 
 * Features:
 * - Pan with drag (+ momentum decay)
 * - Cursor-anchored zoom
 * - Fog matching gameplay reveal
 * - POIs with progressive disclosure
 * - Custom waypoints with persistence
 */

import { isRevealed as fogIsRevealed } from './fog.js';
import { perfStart, perfEnd } from './perf.js';
import { cssVar } from './utils.js';
import { getQuestsByState } from './quests.js';

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // View radius in tiles (from center to edge)
  defaultViewRadius: 40,
  minViewRadius: 12,      // Zoomed in max
  maxViewRadius: 120,     // Zoomed out max (show most of map)
  zoomStep: 8,            // Tiles per scroll step
  
  // Momentum panning
  friction: 0.92,         // Velocity decay per frame
  minVelocity: 0.1,       // Stop when velocity below this
  
  // Marker sizes (canvas pixels)
  playerSize: 12,
  waypointSize: 10,
  questSize: 8,
  poiSize: 6,
  
  // Persistence
  waypointStorageKey: 'vetuu_worldmap_waypoints_v1',
  
  // Performance
  renderThrottle: 16,     // ~60fps max
};

// ============================================
// COLORS - Cached from CSS variables
// ============================================
let COLORS = null;

function getColors() {
  if (!COLORS) {
    COLORS = {
      fog: cssVar('--worldmap-fog') || 'rgba(10, 12, 14, 0.85)',
      player: cssVar('--worldmap-player') || '#EEEEFF',
      playerDirection: cssVar('--worldmap-player-direction') || 'rgba(0, 0, 0, 0.8)',
      waypoint: cssVar('--worldmap-waypoint') || '#00E5E5',
      waypointStroke: cssVar('--worldmap-waypoint-stroke') || 'rgba(0, 0, 0, 0.6)',
      questMain: cssVar('--worldmap-quest-main') || '#FFD700',
      questSide: cssVar('--worldmap-quest-side') || '#FFA500',
      merchant: cssVar('--worldmap-merchant') || '#5DAD5D',
      save: cssVar('--worldmap-save') || '#5A9BD6',
      fastTravel: cssVar('--worldmap-fast-travel') || '#9B59B6',
      regionText: cssVar('--worldmap-region-text') || 'rgba(255, 255, 255, 0.6)',
      regionStroke: cssVar('--worldmap-region-stroke') || 'rgba(0, 0, 0, 0.4)',
      stroke: cssVar('--minimap-stroke') || 'rgba(0, 0, 0, 0.6)',
    };
  }
  return COLORS;
}

// ============================================
// STATE
// ============================================
let overlay = null;
let viewport = null;
let terrainCanvas = null;
let terrainCtx = null;
let overlayCanvas = null;
let overlayCtx = null;

let gameState = null;
let terrainPrerender = null;  // Offscreen canvas with pre-rendered terrain

// Map camera (tile coordinates)
let mapCamX = 0;  // Center X in tiles
let mapCamY = 0;  // Center Y in tiles
let viewRadius = CONFIG.defaultViewRadius;

// Drag/pan state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartCamX = 0;
let dragStartCamY = 0;

// Momentum state
let velocityX = 0;
let velocityY = 0;
let momentumActive = false;
let momentumFrameId = null;
let lastDragX = 0;
let lastDragY = 0;
let lastDragTime = 0;

// Player tracking
let playerFacing = 2;  // Default south
let lastPlayerX = 0;
let lastPlayerY = 0;

// Render state
let needsRender = true;
let isOpen = false;

// UI elements
let coordsEl = null;
let lastCoordsText = '';

// Waypoints
let waypoints = [];

// Filters (match checkbox IDs)
let filters = {
  quests: true,
  merchants: true,
  'save-points': true,
  'fast-travel': true,
  waypoints: true,
};

// ============================================
// INITIALIZATION
// ============================================
export function initWorldMap(state) {
  gameState = state;
  
  overlay = document.getElementById('worldmap-overlay');
  viewport = document.getElementById('worldmap-viewport');
  terrainCanvas = document.getElementById('worldmap-terrain');
  overlayCanvas = document.getElementById('worldmap-overlay-canvas');
  
  if (!overlay || !viewport || !terrainCanvas || !overlayCanvas) {
    console.warn('[WorldMap] Required elements not found');
    return;
  }
  
  terrainCtx = terrainCanvas.getContext('2d', { alpha: false });
  overlayCtx = overlayCanvas.getContext('2d');
  
  // Cache UI element refs
  coordsEl = document.getElementById('worldmap-coords');
  
  // Pre-render terrain
  prerenderTerrain();
  
  // Load waypoints from storage
  loadWaypoints();
  
  // Set up event listeners
  setupEventListeners();
  
  // Initialize camera at player position
  if (state?.player) {
    mapCamX = state.player.x;
    mapCamY = state.player.y;
    lastPlayerX = state.player.x;
    lastPlayerY = state.player.y;
  }
  
  console.log('[WorldMap] Initialized');
}

// ============================================
// PRE-RENDER TERRAIN (1px per tile)
// ============================================
function prerenderTerrain() {
  if (!gameState?.map) return;
  
  const { ground, legend, meta } = gameState.map;
  const width = meta.width;
  const height = meta.height;
  
  // Create offscreen canvas (1 pixel per tile)
  terrainPrerender = document.createElement('canvas');
  terrainPrerender.width = width;
  terrainPrerender.height = height;
  const ctx = terrainPrerender.getContext('2d');
  
  // Draw each tile as a single pixel
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  
  for (let y = 0; y < height; y++) {
    const row = ground[y];
    if (!row) continue;
    
    for (let x = 0; x < row.length; x++) {
      const tileChar = row[x];
      const tile = legend.tiles[tileChar];
      
      if (tile) {
        const color = parseColor(tile.color);
        const idx = (y * width + x) * 4;
        data[idx] = color.r;
        data[idx + 1] = color.g;
        data[idx + 2] = color.b;
        data[idx + 3] = 255;
      }
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  console.log('[WorldMap] Terrain pre-rendered:', width, 'x', height);
}

function parseColor(colorStr) {
  if (colorStr.startsWith('#')) {
    const hex = colorStr.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16)
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return {
      r: parseInt(match[1]),
      g: parseInt(match[2]),
      b: parseInt(match[3])
    };
  }
  
  return { r: 128, g: 128, b: 128 };
}

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
  // Pan with drag
  viewport.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  
  // Zoom with wheel
  viewport.addEventListener('wheel', onWheel, { passive: false });
  
  // Right-click for waypoints
  viewport.addEventListener('contextmenu', onContextMenu);
  
  // Close button
  const closeBtn = overlay.querySelector('.worldmap-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeWorldMap);
  }
  
  // Center on player button
  const centerBtn = document.getElementById('worldmap-center-player');
  if (centerBtn) {
    centerBtn.addEventListener('click', centerOnPlayer);
  }
  
  // Filter checkboxes
  document.querySelectorAll('.worldmap-filter input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', onFilterChange);
  });
  
  // Touch support
  viewport.addEventListener('touchstart', onTouchStart, { passive: false });
  viewport.addEventListener('touchmove', onTouchMove, { passive: false });
  viewport.addEventListener('touchend', onTouchEnd);
  
  // Resize handler
  window.addEventListener('resize', onResize);
}

// ============================================
// OPEN / CLOSE
// ============================================
export function openWorldMap() {
  if (!overlay || isOpen) return;
  
  isOpen = true;
  overlay.classList.add('open');
  
  // Size canvases to viewport
  resizeCanvases();
  
  // Update player position and facing
  updatePlayerPosition();
  
  // Center on player
  centerOnPlayer();
  
  // Populate quest list
  populateQuestList();
  
  // Populate waypoint list
  populateWaypointList();
  
  // Render
  scheduleRender();
  
  console.log('[WorldMap] Opened');
}

export function closeWorldMap() {
  if (!overlay || !isOpen) return;
  
  isOpen = false;
  overlay.classList.remove('open');
  
  // Stop momentum
  stopMomentum();
  
  console.log('[WorldMap] Closed');
}

export function toggleWorldMap() {
  if (isOpen) {
    closeWorldMap();
  } else {
    openWorldMap();
  }
}

export function isWorldMapOpen() {
  return isOpen;
}

// ============================================
// CANVAS SIZING
// ============================================
function resizeCanvases() {
  if (!viewport) return;
  
  const rect = viewport.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  
  if (terrainCanvas.width !== w || terrainCanvas.height !== h) {
    terrainCanvas.width = w;
    terrainCanvas.height = h;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    scheduleRender();
  }
}

function onResize() {
  if (isOpen) {
    resizeCanvases();
  }
}

// ============================================
// PAN (DRAG)
// ============================================
function onMouseDown(e) {
  if (e.button !== 0) return;  // Left click only
  
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartCamX = mapCamX;
  dragStartCamY = mapCamY;
  lastDragX = e.clientX;
  lastDragY = e.clientY;
  lastDragTime = performance.now();
  
  stopMomentum();
  viewport.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  if (!isDragging || !isOpen) return;
  
  const vp = getViewport();
  if (!vp) return;
  
  // Calculate drag delta in tiles
  const dx = (dragStartX - e.clientX) / vp.pixelsPerTile;
  const dy = (dragStartY - e.clientY) / vp.pixelsPerTile;
  
  // Update camera position
  mapCamX = clampCamX(dragStartCamX + dx);
  mapCamY = clampCamY(dragStartCamY + dy);
  
  // Track velocity for momentum
  const now = performance.now();
  const dt = now - lastDragTime;
  if (dt > 0) {
    velocityX = (lastDragX - e.clientX) / vp.pixelsPerTile / dt * 16;  // Normalize to ~60fps
    velocityY = (lastDragY - e.clientY) / vp.pixelsPerTile / dt * 16;
  }
  lastDragX = e.clientX;
  lastDragY = e.clientY;
  lastDragTime = now;
  
  scheduleRender();
}

function onMouseUp() {
  if (!isDragging) return;
  
  isDragging = false;
  viewport.style.cursor = 'grab';
  
  // Start momentum if velocity is significant
  if (Math.abs(velocityX) > CONFIG.minVelocity || Math.abs(velocityY) > CONFIG.minVelocity) {
    startMomentum();
  }
}

// ============================================
// MOMENTUM PANNING
// ============================================
function startMomentum() {
  if (momentumActive) return;
  
  momentumActive = true;
  momentumFrameId = requestAnimationFrame(momentumTick);
}

function stopMomentum() {
  momentumActive = false;
  velocityX = 0;
  velocityY = 0;
  if (momentumFrameId) {
    cancelAnimationFrame(momentumFrameId);
    momentumFrameId = null;
  }
}

function momentumTick() {
  if (!momentumActive || !isOpen) {
    stopMomentum();
    return;
  }
  
  // Apply velocity
  mapCamX = clampCamX(mapCamX + velocityX);
  mapCamY = clampCamY(mapCamY + velocityY);
  
  // Decay velocity
  velocityX *= CONFIG.friction;
  velocityY *= CONFIG.friction;
  
  // Stop if velocity too small
  if (Math.abs(velocityX) < CONFIG.minVelocity && Math.abs(velocityY) < CONFIG.minVelocity) {
    stopMomentum();
    return;
  }
  
  scheduleRender();
  momentumFrameId = requestAnimationFrame(momentumTick);
}

// ============================================
// ZOOM (CURSOR-ANCHORED)
// ============================================
function onWheel(e) {
  e.preventDefault();
  if (!isOpen) return;
  
  const vp = getViewport();
  if (!vp) return;
  
  // Get tile under cursor BEFORE zoom
  const rect = viewport.getBoundingClientRect();
  const cursorX = e.clientX - rect.left;
  const cursorY = e.clientY - rect.top;
  const tileBeforeX = mapCamX + (cursorX - vp.canvasW / 2) / vp.pixelsPerTile;
  const tileBeforeY = mapCamY + (cursorY - vp.canvasH / 2) / vp.pixelsPerTile;
  
  // Continuous zoom: use multiplicative scaling for smooth feel on both
  // trackpads (many small deltas) and mouse wheels (fewer large deltas).
  // Sensitivity tuned so ~100px of scroll = ~2x zoom change.
  const ZOOM_SENSITIVITY = 0.003;
  const factor = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
  
  const oldRadius = viewRadius;
  viewRadius = Math.max(CONFIG.minViewRadius, Math.min(CONFIG.maxViewRadius, viewRadius * factor));
  
  if (Math.abs(viewRadius - oldRadius) > 0.01) {
    // Recalculate pixelsPerTile with new zoom
    const newPixelsPerTile = Math.min(vp.canvasW, vp.canvasH) / (viewRadius * 2);
    
    // Calculate tile under cursor AFTER zoom
    const tileAfterX = mapCamX + (cursorX - vp.canvasW / 2) / newPixelsPerTile;
    const tileAfterY = mapCamY + (cursorY - vp.canvasH / 2) / newPixelsPerTile;
    
    // Adjust camera to keep same tile under cursor
    mapCamX = clampCamX(mapCamX + (tileBeforeX - tileAfterX));
    mapCamY = clampCamY(mapCamY + (tileBeforeY - tileAfterY));
    
    updateZoomDisplay();
    scheduleRender();
  }
}

function updateZoomDisplay() {
  const zoomEl = document.getElementById('worldmap-zoom');
  if (zoomEl) {
    // Calculate zoom level relative to default
    const zoomLevel = CONFIG.defaultViewRadius / viewRadius;
    zoomEl.textContent = `${zoomLevel.toFixed(1)}x`;
  }
}

// ============================================
// WAYPOINTS (RIGHT-CLICK)
// ============================================
function onContextMenu(e) {
  e.preventDefault();
  if (!isOpen) return;
  
  const tilePos = screenToTile(e.clientX, e.clientY);
  if (!tilePos) return;
  
  // Check if clicking on existing waypoint to remove
  const existingIdx = waypoints.findIndex(w => 
    Math.abs(w.x - tilePos.x) < 2 && Math.abs(w.y - tilePos.y) < 2
  );
  
  if (existingIdx >= 0) {
    // Remove waypoint
    waypoints.splice(existingIdx, 1);
  } else {
    // Add new waypoint
    waypoints.push({
      x: tilePos.x,
      y: tilePos.y,
      label: `Waypoint ${waypoints.length + 1}`,
    });
  }
  
  saveWaypoints();
  populateWaypointList();
  scheduleRender();
}

function saveWaypoints() {
  try {
    localStorage.setItem(CONFIG.waypointStorageKey, JSON.stringify(waypoints));
  } catch (e) {
    console.warn('[WorldMap] Failed to save waypoints:', e);
  }
}

function loadWaypoints() {
  try {
    const saved = localStorage.getItem(CONFIG.waypointStorageKey);
    if (saved) {
      waypoints = JSON.parse(saved);
    }
  } catch (e) {
    console.warn('[WorldMap] Failed to load waypoints:', e);
    waypoints = [];
  }
}

function removeWaypoint(index) {
  waypoints.splice(index, 1);
  saveWaypoints();
  populateWaypointList();
  scheduleRender();
}

function populateWaypointList() {
  const list = document.getElementById('worldmap-waypoint-list');
  if (!list) return;
  
  if (waypoints.length === 0) {
    list.innerHTML = '<div class="worldmap-empty">Right-click on map to add waypoints</div>';
    return;
  }
  
  list.innerHTML = waypoints.map((wp, i) => `
    <div class="worldmap-waypoint-item" data-index="${i}">
      <span class="worldmap-waypoint-icon"></span>
      <span class="worldmap-waypoint-coords">(${wp.x}, ${wp.y})</span>
      <button class="worldmap-waypoint-delete" data-index="${i}">&times;</button>
    </div>
  `).join('');
  
  // Add click handlers
  list.querySelectorAll('.worldmap-waypoint-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('worldmap-waypoint-delete')) {
        removeWaypoint(parseInt(e.target.dataset.index));
      } else {
        // Pan to waypoint
        const wp = waypoints[parseInt(item.dataset.index)];
        if (wp) {
          mapCamX = wp.x;
          mapCamY = wp.y;
          scheduleRender();
        }
      }
    });
  });
}

// ============================================
// FILTERS
// ============================================
function onFilterChange(e) {
  const filterId = e.target.id.replace('filter-', '');
  filters[filterId] = e.target.checked;
  scheduleRender();
}

// ============================================
// QUEST LIST
// ============================================
function populateQuestList() {
  const list = document.getElementById('worldmap-quest-list');
  if (!list || !gameState) return;
  
  const activeQuests = getQuestsByState(gameState, 'active');
  
  if (activeQuests.length === 0) {
    list.innerHTML = '<div class="worldmap-empty">No active quests</div>';
    return;
  }
  
  list.innerHTML = activeQuests.map(quest => {
    // Get current objective
    const progress = gameState.quests.progress[quest.id] || {};
    const objectives = quest.objectives || [];
    const currentObj = objectives.find(obj => {
      const count = progress[obj.id] || 0;
      return count < (obj.count || 1);
    });
    
    return `
      <div class="worldmap-quest-item" data-quest-id="${quest.id}">
        <div class="worldmap-quest-name">${quest.name}</div>
        ${currentObj ? `<div class="worldmap-quest-objective">${currentObj.description}</div>` : ''}
      </div>
    `;
  }).join('');
  
  // Add click handlers to pan to quest location (if available)
  list.querySelectorAll('.worldmap-quest-item').forEach(item => {
    item.addEventListener('click', () => {
      const quest = activeQuests.find(q => q.id === item.dataset.questId);
      if (quest?.location) {
        mapCamX = quest.location.x;
        mapCamY = quest.location.y;
        scheduleRender();
      }
    });
  });
}

// ============================================
// CENTER ON PLAYER
// ============================================
function centerOnPlayer() {
  if (!gameState?.player) return;
  
  mapCamX = gameState.player.x;
  mapCamY = gameState.player.y;
  scheduleRender();
}

function updatePlayerPosition() {
  if (!gameState?.player) return;
  
  const dx = gameState.player.x - lastPlayerX;
  const dy = gameState.player.y - lastPlayerY;
  
  // Update facing direction based on movement
  if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const isDiagonal = absDx > 0.05 && absDy > 0.05 && absDx / absDy < 2 && absDy / absDx < 2;
    
    if (isDiagonal) {
      if (dx > 0 && dy > 0) playerFacing = 1;      // Down-right
      else if (dx < 0 && dy > 0) playerFacing = 3; // Down-left
      else if (dx < 0 && dy < 0) playerFacing = 5; // Up-left
      else playerFacing = 7;                        // Up-right
    } else {
      if (absDx > absDy) {
        playerFacing = dx > 0 ? 0 : 4;  // Right or Left
      } else {
        playerFacing = dy > 0 ? 2 : 6;  // Down or Up
      }
    }
  }
  
  lastPlayerX = gameState.player.x;
  lastPlayerY = gameState.player.y;
}

// ============================================
// COORDINATE CONVERSION
// ============================================
function getViewport() {
  if (!terrainCanvas) return null;
  
  const canvasW = terrainCanvas.width;
  const canvasH = terrainCanvas.height;
  
  if (canvasW === 0 || canvasH === 0) return null;
  
  // Calculate pixels per tile based on view radius
  const tilesVisible = viewRadius * 2;
  const pixelsPerTile = Math.min(canvasW, canvasH) / tilesVisible;
  
  // Calculate world bounds visible
  const tilesX = canvasW / pixelsPerTile;
  const tilesY = canvasH / pixelsPerTile;
  
  return {
    centerX: mapCamX,
    centerY: mapCamY,
    left: mapCamX - tilesX / 2,
    top: mapCamY - tilesY / 2,
    right: mapCamX + tilesX / 2,
    bottom: mapCamY + tilesY / 2,
    tilesX,
    tilesY,
    pixelsPerTile,
    canvasW,
    canvasH,
  };
}

function tileToScreen(tileX, tileY) {
  const vp = getViewport();
  if (!vp) return null;
  
  const screenX = (tileX - vp.left) * vp.pixelsPerTile;
  const screenY = (tileY - vp.top) * vp.pixelsPerTile;
  
  return { x: screenX, y: screenY };
}

function screenToTile(screenX, screenY) {
  const vp = getViewport();
  if (!vp) return null;
  
  const rect = viewport.getBoundingClientRect();
  const localX = screenX - rect.left;
  const localY = screenY - rect.top;
  
  const tileX = Math.floor(vp.left + localX / vp.pixelsPerTile);
  const tileY = Math.floor(vp.top + localY / vp.pixelsPerTile);
  
  return { x: tileX, y: tileY };
}

function clampCamX(x) {
  if (!gameState?.map) return x;
  const half = getViewport()?.tilesX / 2 || 0;
  return Math.max(half, Math.min(gameState.map.meta.width - half, x));
}

function clampCamY(y) {
  if (!gameState?.map) return y;
  const half = getViewport()?.tilesY / 2 || 0;
  return Math.max(half, Math.min(gameState.map.meta.height - half, y));
}

// ============================================
// TOUCH SUPPORT
// ============================================
let touchStartX = 0;
let touchStartY = 0;
let touchStartCamX = 0;
let touchStartCamY = 0;
let lastTouchDist = null;

function onTouchStart(e) {
  if (e.touches.length === 1) {
    // Single touch - pan
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartCamX = mapCamX;
    touchStartCamY = mapCamY;
    lastDragX = touchStartX;
    lastDragY = touchStartY;
    lastDragTime = performance.now();
    isDragging = true;
    stopMomentum();
  } else if (e.touches.length === 2) {
    // Pinch zoom
    lastTouchDist = getTouchDistance(e.touches);
  }
}

function onTouchMove(e) {
  e.preventDefault();
  
  if (e.touches.length === 1 && isDragging) {
    const vp = getViewport();
    if (!vp) return;
    
    const dx = (touchStartX - e.touches[0].clientX) / vp.pixelsPerTile;
    const dy = (touchStartY - e.touches[0].clientY) / vp.pixelsPerTile;
    
    mapCamX = clampCamX(touchStartCamX + dx);
    mapCamY = clampCamY(touchStartCamY + dy);
    
    // Track velocity
    const now = performance.now();
    const dt = now - lastDragTime;
    if (dt > 0) {
      velocityX = (lastDragX - e.touches[0].clientX) / vp.pixelsPerTile / dt * 16;
      velocityY = (lastDragY - e.touches[0].clientY) / vp.pixelsPerTile / dt * 16;
    }
    lastDragX = e.touches[0].clientX;
    lastDragY = e.touches[0].clientY;
    lastDragTime = now;
    
    scheduleRender();
  } else if (e.touches.length === 2 && lastTouchDist !== null) {
    // Pinch zoom - continuous scaling
    const dist = getTouchDistance(e.touches);
    const scale = dist / lastTouchDist;
    
    // Apply continuous zoom: pinch out (scale > 1) = zoom in = smaller radius
    const oldRadius = viewRadius;
    viewRadius = Math.max(CONFIG.minViewRadius, Math.min(CONFIG.maxViewRadius, viewRadius / scale));
    lastTouchDist = dist;
    
    if (Math.abs(viewRadius - oldRadius) > 0.01) {
      updateZoomDisplay();
      scheduleRender();
    }
  }
}

function onTouchEnd() {
  if (isDragging) {
    isDragging = false;
    if (Math.abs(velocityX) > CONFIG.minVelocity || Math.abs(velocityY) > CONFIG.minVelocity) {
      startMomentum();
    }
  }
  lastTouchDist = null;
}

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// ============================================
// RENDER
// ============================================
function scheduleRender() {
  needsRender = true;
  // Use RAF to batch multiple render requests
  requestAnimationFrame(render);
}

function render() {
  if (!needsRender || !isOpen) return;
  needsRender = false;
  
  perfStart('worldmap:render');
  
  const vp = getViewport();
  if (!vp) {
    perfEnd('worldmap:render');
    return;
  }
  
  // Render terrain
  renderTerrain(vp);
  
  // Render overlay (fog, markers, labels)
  renderOverlay(vp);
  
  // Update position display
  updatePositionDisplay(vp);
  
  perfEnd('worldmap:render');
}

function renderTerrain(vp) {
  if (!terrainCtx || !terrainPrerender) return;
  
  const { left, top, tilesX, tilesY, pixelsPerTile, canvasW, canvasH } = vp;
  
  // Clear canvas with dark background
  terrainCtx.fillStyle = '#0a0c0e';
  terrainCtx.fillRect(0, 0, canvasW, canvasH);
  
  // Calculate source rectangle (in terrain image pixels = tiles)
  const srcX = Math.max(0, Math.floor(left));
  const srcY = Math.max(0, Math.floor(top));
  const srcW = Math.min(terrainPrerender.width - srcX, Math.ceil(tilesX) + 2);
  const srcH = Math.min(terrainPrerender.height - srcY, Math.ceil(tilesY) + 2);
  
  if (srcW <= 0 || srcH <= 0) return;
  
  // Calculate destination rectangle
  const dstX = (srcX - left) * pixelsPerTile;
  const dstY = (srcY - top) * pixelsPerTile;
  const dstW = srcW * pixelsPerTile;
  const dstH = srcH * pixelsPerTile;
  
  // Disable image smoothing for crisp pixels
  terrainCtx.imageSmoothingEnabled = false;
  
  // Draw the visible portion of terrain, scaled up
  terrainCtx.drawImage(
    terrainPrerender,
    srcX, srcY, srcW, srcH,
    dstX, dstY, dstW, dstH
  );
}

function renderOverlay(vp) {
  if (!overlayCtx) return;
  
  const { canvasW, canvasH } = vp;
  
  // Clear overlay
  overlayCtx.clearRect(0, 0, canvasW, canvasH);
  
  // Render fog
  renderFog(vp);
  
  // Render region labels (at low zoom)
  renderRegionLabels(vp);
  
  // Render POIs based on filters
  if (filters.quests) renderQuestMarkers(vp);
  if (filters.merchants) renderPOIMarkers(vp, 'merchant');
  if (filters['save-points']) renderPOIMarkers(vp, 'save');
  if (filters['fast-travel']) renderPOIMarkers(vp, 'fastTravel');
  
  // Render waypoints
  if (filters.waypoints) renderWaypoints(vp);
  
  // Render player (always on top)
  renderPlayer(vp);
}

function renderFog(vp) {
  const { left, top, right, bottom, pixelsPerTile, canvasW, canvasH } = vp;
  const colors = getColors();
  
  // Fill with fog
  overlayCtx.fillStyle = colors.fog;
  overlayCtx.fillRect(0, 0, canvasW, canvasH);
  
  // Cut out revealed tiles
  overlayCtx.globalCompositeOperation = 'destination-out';
  overlayCtx.fillStyle = 'white';
  
  // Only process tiles in view
  const mapWidth = gameState?.map?.meta?.width || 0;
  const mapHeight = gameState?.map?.meta?.height || 0;
  
  const startX = Math.max(0, Math.floor(left) - 1);
  const startY = Math.max(0, Math.floor(top) - 1);
  const endX = Math.min(mapWidth, Math.ceil(right) + 1);
  const endY = Math.min(mapHeight, Math.ceil(bottom) + 1);
  
  // Pre-calculate screen offset
  const offsetX = -left * pixelsPerTile;
  const offsetY = -top * pixelsPerTile;
  const tileDrawSize = pixelsPerTile + 1;
  
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      if (fogIsRevealed(x, y)) {
        const screenX = x * pixelsPerTile + offsetX - 0.5;
        const screenY = y * pixelsPerTile + offsetY - 0.5;
        overlayCtx.fillRect(screenX, screenY, tileDrawSize, tileDrawSize);
      }
    }
  }
  
  overlayCtx.globalCompositeOperation = 'source-over';
}

function renderRegionLabels(vp) {
  if (!gameState?.map?.regions) return;
  
  const colors = getColors();
  const { pixelsPerTile } = vp;
  
  // Only show region labels at medium zoom or higher
  if (viewRadius > 80) return;
  
  // Calculate font size based on zoom
  const fontSize = Math.max(12, Math.min(24, pixelsPerTile * 2));
  
  overlayCtx.font = `bold ${fontSize}px ${cssVar('--font-display') || 'monospace'}`;
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  
  for (const region of gameState.map.regions) {
    const offset = gameState.map.meta.originalOffset || { x: 0, y: 0 };
    const centerX = (region.bounds.x0 + region.bounds.x1) / 2 + offset.x;
    const centerY = (region.bounds.y0 + region.bounds.y1) / 2 + offset.y;
    
    // Check if in view
    if (centerX < vp.left - 20 || centerX > vp.right + 20 ||
        centerY < vp.top - 20 || centerY > vp.bottom + 20) {
      continue;
    }
    
    const pos = tileToScreen(centerX, centerY);
    if (!pos) continue;
    
    // Check if region is revealed (at least center tile)
    if (!fogIsRevealed(Math.floor(centerX), Math.floor(centerY))) {
      continue;
    }
    
    // Draw text with stroke for readability
    overlayCtx.strokeStyle = colors.regionStroke;
    overlayCtx.lineWidth = 3;
    overlayCtx.strokeText(region.name, pos.x, pos.y);
    
    overlayCtx.fillStyle = colors.regionText;
    overlayCtx.fillText(region.name, pos.x, pos.y);
  }
}

function renderQuestMarkers(vp) {
  if (!gameState) return;
  
  const colors = getColors();
  const activeQuests = getQuestsByState(gameState, 'active');
  
  for (const quest of activeQuests) {
    if (!quest.location) continue;
    
    const { x, y } = quest.location;
    
    // Check fog
    if (!fogIsRevealed(x, y)) continue;
    
    // Check in view
    if (x < vp.left - 2 || x > vp.right + 2 || y < vp.top - 2 || y > vp.bottom + 2) {
      continue;
    }
    
    const pos = tileToScreen(x + 0.5, y + 0.5);
    if (!pos) continue;
    
    // Draw quest marker (exclamation diamond)
    const size = CONFIG.questSize;
    const color = quest.type === 'main' ? colors.questMain : colors.questSide;
    
    overlayCtx.save();
    overlayCtx.translate(pos.x, pos.y);
    overlayCtx.rotate(Math.PI / 4);
    
    overlayCtx.fillStyle = color;
    overlayCtx.fillRect(-size / 2, -size / 2, size, size);
    
    overlayCtx.strokeStyle = colors.stroke;
    overlayCtx.lineWidth = 1;
    overlayCtx.strokeRect(-size / 2, -size / 2, size, size);
    
    overlayCtx.restore();
  }
}

function renderPOIMarkers(vp, poiType) {
  if (!gameState?.map?.objects) return;
  
  const colors = getColors();
  
  // Filter objects by type
  const pois = gameState.map.objects.filter(obj => {
    if (poiType === 'merchant') return obj.interact?.action === 'shop';
    if (poiType === 'save') return obj.interact?.action === 'save';
    if (poiType === 'fastTravel') return obj.interact?.action === 'fastTravel';
    return false;
  });
  
  for (const poi of pois) {
    // Check fog
    if (!fogIsRevealed(poi.x, poi.y)) continue;
    
    // Check in view
    if (poi.x < vp.left - 2 || poi.x > vp.right + 2 || 
        poi.y < vp.top - 2 || poi.y > vp.bottom + 2) {
      continue;
    }
    
    const pos = tileToScreen(poi.x + 0.5, poi.y + 0.5);
    if (!pos) continue;
    
    // Draw POI marker (circle)
    const size = CONFIG.poiSize;
    let color = colors.stroke;
    
    if (poiType === 'merchant') color = colors.merchant;
    else if (poiType === 'save') color = colors.save;
    else if (poiType === 'fastTravel') color = colors.fastTravel;
    
    overlayCtx.beginPath();
    overlayCtx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
    overlayCtx.fillStyle = color;
    overlayCtx.fill();
    overlayCtx.strokeStyle = colors.stroke;
    overlayCtx.lineWidth = 1;
    overlayCtx.stroke();
  }
}

function renderWaypoints(vp) {
  const colors = getColors();
  
  for (const wp of waypoints) {
    // Waypoints are always visible (even in fog)
    
    // Check in view
    if (wp.x < vp.left - 2 || wp.x > vp.right + 2 || 
        wp.y < vp.top - 2 || wp.y > vp.bottom + 2) {
      continue;
    }
    
    const pos = tileToScreen(wp.x + 0.5, wp.y + 0.5);
    if (!pos) continue;
    
    // Draw waypoint marker (diamond with glow)
    const size = CONFIG.waypointSize;
    
    overlayCtx.save();
    overlayCtx.translate(pos.x, pos.y);
    
    // Glow effect
    overlayCtx.shadowColor = colors.waypoint;
    overlayCtx.shadowBlur = 8;
    
    // Diamond shape
    overlayCtx.beginPath();
    overlayCtx.moveTo(0, -size / 2);
    overlayCtx.lineTo(size / 2, 0);
    overlayCtx.lineTo(0, size / 2);
    overlayCtx.lineTo(-size / 2, 0);
    overlayCtx.closePath();
    
    overlayCtx.fillStyle = colors.waypoint;
    overlayCtx.fill();
    
    overlayCtx.shadowBlur = 0;
    overlayCtx.strokeStyle = colors.waypointStroke;
    overlayCtx.lineWidth = 1;
    overlayCtx.stroke();
    
    overlayCtx.restore();
  }
}

function renderPlayer(vp) {
  if (!gameState?.player) return;
  
  const colors = getColors();
  const pos = tileToScreen(gameState.player.x + 0.5, gameState.player.y + 0.5);
  if (!pos) return;
  
  const size = CONFIG.playerSize;
  const halfSize = size / 2;
  const triSize = size * 0.5;
  const halfTriSize = triSize / 2;
  
  // Player square
  overlayCtx.fillStyle = colors.player;
  overlayCtx.fillRect(pos.x - halfSize, pos.y - halfSize, size, size);
  
  // Border
  overlayCtx.strokeStyle = colors.playerDirection;
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(pos.x - halfSize, pos.y - halfSize, size, size);
  
  // Direction triangle
  overlayCtx.fillStyle = colors.playerDirection;
  overlayCtx.beginPath();
  
  const diagTriOffset = triSize * 0.707;
  
  switch (playerFacing) {
    case 0: // Right
      overlayCtx.moveTo(pos.x + halfSize, pos.y - halfTriSize);
      overlayCtx.lineTo(pos.x + halfSize + triSize, pos.y);
      overlayCtx.lineTo(pos.x + halfSize, pos.y + halfTriSize);
      break;
    case 1: // Down-right
      overlayCtx.moveTo(pos.x + halfSize, pos.y + halfSize - halfTriSize);
      overlayCtx.lineTo(pos.x + halfSize + diagTriOffset, pos.y + halfSize + diagTriOffset);
      overlayCtx.lineTo(pos.x + halfSize - halfTriSize, pos.y + halfSize);
      break;
    case 2: // Down
      overlayCtx.moveTo(pos.x - halfTriSize, pos.y + halfSize);
      overlayCtx.lineTo(pos.x, pos.y + halfSize + triSize);
      overlayCtx.lineTo(pos.x + halfTriSize, pos.y + halfSize);
      break;
    case 3: // Down-left
      overlayCtx.moveTo(pos.x - halfSize + halfTriSize, pos.y + halfSize);
      overlayCtx.lineTo(pos.x - halfSize - diagTriOffset, pos.y + halfSize + diagTriOffset);
      overlayCtx.lineTo(pos.x - halfSize, pos.y + halfSize - halfTriSize);
      break;
    case 4: // Left
      overlayCtx.moveTo(pos.x - halfSize, pos.y - halfTriSize);
      overlayCtx.lineTo(pos.x - halfSize - triSize, pos.y);
      overlayCtx.lineTo(pos.x - halfSize, pos.y + halfTriSize);
      break;
    case 5: // Up-left
      overlayCtx.moveTo(pos.x - halfSize, pos.y - halfSize + halfTriSize);
      overlayCtx.lineTo(pos.x - halfSize - diagTriOffset, pos.y - halfSize - diagTriOffset);
      overlayCtx.lineTo(pos.x - halfSize + halfTriSize, pos.y - halfSize);
      break;
    case 6: // Up
      overlayCtx.moveTo(pos.x - halfTriSize, pos.y - halfSize);
      overlayCtx.lineTo(pos.x, pos.y - halfSize - triSize);
      overlayCtx.lineTo(pos.x + halfTriSize, pos.y - halfSize);
      break;
    case 7: // Up-right
      overlayCtx.moveTo(pos.x + halfSize - halfTriSize, pos.y - halfSize);
      overlayCtx.lineTo(pos.x + halfSize + diagTriOffset, pos.y - halfSize - diagTriOffset);
      overlayCtx.lineTo(pos.x + halfSize, pos.y - halfSize + halfTriSize);
      break;
  }
  
  overlayCtx.closePath();
  overlayCtx.fill();
}

function updatePositionDisplay(vp) {
  const posEl = document.getElementById('worldmap-position');
  if (!gameState) return;
  
  // Find current region
  const offset = gameState.map?.meta?.originalOffset || { x: 0, y: 0 };
  const playerX = gameState.player.x;
  const playerY = gameState.player.y;
  
  let regionName = 'Unknown';
  
  for (const region of gameState.map?.regions || []) {
    const b = region.bounds;
    const x0 = b.x0 + offset.x;
    const y0 = b.y0 + offset.y;
    const x1 = b.x1 + offset.x;
    const y1 = b.y1 + offset.y;
    
    if (playerX >= x0 && playerX <= x1 && playerY >= y0 && playerY <= y1) {
      regionName = region.name;
      break;
    }
  }
  
  if (posEl) {
    posEl.textContent = regionName;
  }
  
  // Update coords badge (shows map center tile, useful for mapping POIs + waypoints)
  if (coordsEl) {
    const x = Math.floor(mapCamX);
    const y = Math.floor(mapCamY);
    const text = `X: ${x} Y: ${y}`;
    if (text !== lastCoordsText) {
      coordsEl.textContent = text;
      lastCoordsText = text;
    }
  }
}

// ============================================
// DEBUG
// ============================================
export function debugWorldMap() {
  const vp = getViewport();
  
  console.log('[WorldMap Debug]');
  console.log('  isOpen:', isOpen);
  console.log('  mapCam:', mapCamX.toFixed(1), mapCamY.toFixed(1));
  console.log('  viewRadius:', viewRadius);
  console.log('  viewport:', vp);
  console.log('  waypoints:', waypoints.length);
  console.log('  filters:', filters);
  
  if (vp) {
    const startX = Math.max(0, Math.floor(vp.left));
    const endX = Math.min(gameState?.map?.meta?.width || 0, Math.ceil(vp.right));
    const startY = Math.max(0, Math.floor(vp.top));
    const endY = Math.min(gameState?.map?.meta?.height || 0, Math.ceil(vp.bottom));
    console.log('  visible tiles:', (endX - startX) * (endY - startY));
  }
  
  return { isOpen, mapCamX, mapCamY, viewRadius, waypoints, filters };
}

// Expose to console
if (typeof window !== 'undefined') {
  window.VETUU_WORLDMAP = toggleWorldMap;
  window.VETUU_WORLDMAP_DEBUG = debugWorldMap;
}

