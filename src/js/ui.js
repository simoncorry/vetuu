/**
 * VETUU — UI Module
 * Manages draggable/resizable windows, settings menu, and panel state
 * 
 * ANIMATION RULE: All motion uses CSS transitions/animations for GPU acceleration.
 * JavaScript only sets final positions - CSS handles interpolation.
 */

// ============================================
// PANEL STATE
// ============================================
const panelState = {
  characterSheet: { visible: false },
  settings: { visible: false },
  minimap: { 
    visible: true, 
    docked: true,
    x: null, y: null,
    width: null, height: null,
    zoom: 1
  },
  quests: { 
    visible: true, 
    docked: true,
    x: null, y: null,
    width: null, height: null
  }
};

// Default positions and sizes (will be set after init based on CSS)
const defaultState = {
  minimap: { top: 16, right: 16, width: 220, height: 180 },
  quests: { top: 220, right: 16, width: 220, height: null } // height auto
};

// Active drag/resize state
let activeDrag = null;
let activeResize = null;

// ============================================
// INITIALIZATION
// ============================================
export function initUI() {
  // Initialize draggable panels
  initDraggablePanel('minimap-container', 'minimap');
  initDraggablePanel('quest-tracker', 'quests');
  
  // Initialize minimap zoom
  initMinimapZoom();
  
  // Store default positions after layout
  requestAnimationFrame(() => {
    cacheDefaultPositions();
  });
  
  console.log('[UI] Module initialized');
}

function cacheDefaultPositions() {
  const minimapEl = document.getElementById('minimap-container');
  const questsEl = document.getElementById('quest-tracker');
  
  if (minimapEl) {
    const rect = minimapEl.getBoundingClientRect();
    defaultState.minimap.width = rect.width;
    defaultState.minimap.height = rect.height;
  }
  
  if (questsEl) {
    const rect = questsEl.getBoundingClientRect();
    defaultState.quests.width = rect.width;
    defaultState.quests.height = rect.height;
  }
}

// ============================================
// DRAGGABLE PANEL SYSTEM
// ============================================
function initDraggablePanel(elementId, panelKey) {
  const el = document.getElementById(elementId);
  if (!el) return;
  
  // Add panel classes
  el.classList.add('ui-panel', 'ui-draggable');
  
  // Create header with title and controls
  const existingHeader = el.querySelector('.panel-header');
  if (!existingHeader) {
    const header = document.createElement('div');
    header.className = 'panel-header';
    
    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = panelKey === 'minimap' ? 'Map' : 'Quests';
    
    const controls = document.createElement('div');
    controls.className = 'panel-controls';
    
    // Dock button (appears when undocked)
    const dockBtn = document.createElement('button');
    dockBtn.className = 'panel-btn dock-btn';
    dockBtn.innerHTML = '⊡';
    dockBtn.title = 'Dock to default position';
    dockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dockPanel(elementId, panelKey);
    });
    
    controls.appendChild(dockBtn);
    header.appendChild(title);
    header.appendChild(controls);
    
    el.insertBefore(header, el.firstChild);
  }
  
  // Create resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';
  el.appendChild(resizeHandle);
  
  // Create redock indicator
  const redockIndicator = document.createElement('div');
  redockIndicator.className = 'redock-indicator';
  redockIndicator.innerHTML = '<span>Release to dock</span>';
  el.appendChild(redockIndicator);
  
  // Drag handling on header
  const header = el.querySelector('.panel-header');
  if (header) {
    header.addEventListener('mousedown', (e) => startDrag(e, el, panelKey));
    header.addEventListener('touchstart', (e) => startDrag(e, el, panelKey), { passive: false });
  }
  
  // Resize handling
  resizeHandle.addEventListener('mousedown', (e) => startResize(e, el, panelKey));
  resizeHandle.addEventListener('touchstart', (e) => startResize(e, el, panelKey), { passive: false });
}

function startDrag(e, el, panelKey) {
  e.preventDefault();
  
  const touch = e.touches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  
  const rect = el.getBoundingClientRect();
  
  activeDrag = {
    el,
    panelKey,
    offsetX: clientX - rect.left,
    offsetY: clientY - rect.top,
    startX: rect.left,
    startY: rect.top
  };
  
  el.classList.add('dragging');
  
  // Add move/end listeners
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchmove', onDrag, { passive: false });
  document.addEventListener('touchend', endDrag);
}

function onDrag(e) {
  if (!activeDrag) return;
  e.preventDefault();
  
  const touch = e.touches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  
  const { el, panelKey, offsetX, offsetY } = activeDrag;
  
  // Calculate new position
  let newX = clientX - offsetX;
  let newY = clientY - offsetY;
  
  // Clamp to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  
  newX = Math.max(0, Math.min(newX, vw - rect.width));
  newY = Math.max(0, Math.min(newY, vh - rect.height));
  
  // Apply position
  el.style.left = `${newX}px`;
  el.style.top = `${newY}px`;
  el.style.right = 'auto';
  
  // Update state
  panelState[panelKey].docked = false;
  panelState[panelKey].x = newX;
  panelState[panelKey].y = newY;
  
  el.classList.add('undocked');
  
  // Check if near dock position
  const nearDock = isNearDockPosition(newX, newY, panelKey);
  el.classList.toggle('near-dock', nearDock);
}

function endDrag() {
  if (!activeDrag) return;
  
  const { el, panelKey } = activeDrag;
  
  el.classList.remove('dragging');
  
  // Check if should dock
  const rect = el.getBoundingClientRect();
  if (isNearDockPosition(rect.left, rect.top, panelKey)) {
    dockPanel(el.id, panelKey);
  }
  
  activeDrag = null;
  
  // Remove listeners
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  document.removeEventListener('touchmove', onDrag);
  document.removeEventListener('touchend', endDrag);
  
  savePanelState();
}

function startResize(e, el, panelKey) {
  e.preventDefault();
  e.stopPropagation();
  
  const touch = e.touches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  
  const rect = el.getBoundingClientRect();
  
  activeResize = {
    el,
    panelKey,
    startX: clientX,
    startY: clientY,
    startWidth: rect.width,
    startHeight: rect.height
  };
  
  el.classList.add('resizing');
  
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', endResize);
  document.addEventListener('touchmove', onResize, { passive: false });
  document.addEventListener('touchend', endResize);
}

function onResize(e) {
  if (!activeResize) return;
  e.preventDefault();
  
  const touch = e.touches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  
  const { el, panelKey, startX, startY, startWidth, startHeight } = activeResize;
  
  const deltaX = clientX - startX;
  const deltaY = clientY - startY;
  
  // Calculate new size with min/max constraints
  const minWidth = panelKey === 'minimap' ? 150 : 150;
  const minHeight = panelKey === 'minimap' ? 120 : 100;
  const maxWidth = 500;
  const maxHeight = 400;
  
  const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
  const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
  
  el.style.width = `${newWidth}px`;
  el.style.height = `${newHeight}px`;
  
  // Update state
  panelState[panelKey].width = newWidth;
  panelState[panelKey].height = newHeight;
  
  // For minimap, update canvas size
  if (panelKey === 'minimap') {
    updateMinimapSize(newWidth, newHeight);
  }
}

function endResize() {
  if (!activeResize) return;
  
  const { el } = activeResize;
  el.classList.remove('resizing');
  
  activeResize = null;
  
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', endResize);
  document.removeEventListener('touchmove', onResize);
  document.removeEventListener('touchend', endResize);
  
  savePanelState();
}

function isNearDockPosition(x, y, panelKey) {
  const threshold = 40;
  const def = defaultState[panelKey];
  
  // Calculate default position (right-aligned)
  const vw = window.innerWidth;
  const defaultX = vw - def.right - (panelState[panelKey].width || def.width);
  const defaultY = def.top;
  
  const dx = Math.abs(x - defaultX);
  const dy = Math.abs(y - defaultY);
  
  return dx < threshold && dy < threshold;
}

function dockPanel(elementId, panelKey) {
  const el = document.getElementById(elementId);
  if (!el) return;
  
  // Reset to CSS defaults
  el.style.left = '';
  el.style.top = '';
  el.style.right = '';
  el.style.width = '';
  el.style.height = '';
  
  el.classList.remove('undocked', 'near-dock');
  
  panelState[panelKey].docked = true;
  panelState[panelKey].x = null;
  panelState[panelKey].y = null;
  panelState[panelKey].width = null;
  panelState[panelKey].height = null;
  
  // Reset minimap zoom
  if (panelKey === 'minimap') {
    panelState.minimap.zoom = 1;
    updateMinimapZoom(1);
  }
  
  savePanelState();
}

// ============================================
// MINIMAP ZOOM
// ============================================
function initMinimapZoom() {
  const minimapContainer = document.getElementById('minimap-container');
  const minimap = document.getElementById('minimap');
  
  if (!minimap || !minimapContainer) return;
  
  // Wheel zoom
  minimapContainer.addEventListener('wheel', (e) => {
    // Only zoom if hovering over minimap content area
    if (!e.target.closest('#minimap')) return;
    
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const newZoom = Math.max(0.5, Math.min(3, panelState.minimap.zoom + delta));
    
    panelState.minimap.zoom = newZoom;
    updateMinimapZoom(newZoom);
  }, { passive: false });
  
  // Pinch zoom (touch)
  let lastTouchDist = null;
  
  minimapContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lastTouchDist = getTouchDistance(e.touches);
    }
  }, { passive: true });
  
  minimapContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && lastTouchDist !== null) {
      e.preventDefault();
      
      const dist = getTouchDistance(e.touches);
      const scale = dist / lastTouchDist;
      
      const newZoom = Math.max(0.5, Math.min(3, panelState.minimap.zoom * scale));
      panelState.minimap.zoom = newZoom;
      updateMinimapZoom(newZoom);
      
      lastTouchDist = dist;
    }
  }, { passive: false });
  
  minimapContainer.addEventListener('touchend', () => {
    lastTouchDist = null;
  }, { passive: true });
}

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function updateMinimapZoom(zoom) {
  const minimap = document.getElementById('minimap');
  const canvas = document.getElementById('minimap-canvas');
  const fogCanvas = document.getElementById('minimap-fog');
  
  if (!minimap) return;
  
  // Scale the internal content
  minimap.style.setProperty('--minimap-zoom', zoom);
  
  // Update canvas transforms
  if (canvas) {
    canvas.style.transform = `scale3d(${zoom}, ${zoom}, 1)`;
    canvas.style.transformOrigin = 'center center';
  }
  if (fogCanvas) {
    fogCanvas.style.transform = `scale3d(${zoom}, ${zoom}, 1)`;
    fogCanvas.style.transformOrigin = 'center center';
  }
}

function updateMinimapSize(width, height) {
  const minimap = document.getElementById('minimap');
  if (!minimap) return;
  
  // Adjust inner minimap size (account for padding)
  const innerWidth = width - 16; // padding
  const innerHeight = height - 48; // padding + header + label
  
  minimap.style.width = `${Math.max(100, innerWidth)}px`;
  minimap.style.height = `${Math.max(80, innerHeight)}px`;
}

// ============================================
// PANEL TOGGLES
// ============================================
export function toggleCharacterSheet() {
  const el = document.getElementById('character-sheet');
  if (!el) return;
  
  panelState.characterSheet.visible = !panelState.characterSheet.visible;
  el.classList.toggle('visible', panelState.characterSheet.visible);
  
  return panelState.characterSheet.visible;
}

export function toggleSettings() {
  const el = document.getElementById('settings-menu');
  if (!el) return;
  
  panelState.settings.visible = !panelState.settings.visible;
  el.classList.toggle('visible', panelState.settings.visible);
  
  return panelState.settings.visible;
}

export function toggleMinimap() {
  const el = document.getElementById('minimap-container');
  if (!el) return;
  
  panelState.minimap.visible = !panelState.minimap.visible;
  el.classList.toggle('hidden', !panelState.minimap.visible);
  
  return panelState.minimap.visible;
}

export function toggleQuestTracker() {
  const el = document.getElementById('quest-tracker');
  if (!el) return;
  
  panelState.quests.visible = !panelState.quests.visible;
  el.classList.toggle('hidden', !panelState.quests.visible);
  
  return panelState.quests.visible;
}

export function isSettingsVisible() {
  return panelState.settings.visible;
}

export function isCharacterSheetVisible() {
  return panelState.characterSheet.visible;
}

// ============================================
// SETTINGS MENU
// ============================================
export function initSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (!menu) return;
  
  // Reset button handler
  const resetBtn = menu.querySelector('#reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all game progress? This cannot be undone.')) {
        localStorage.clear();
        window.location.reload();
      }
    });
  }
  
  // Close button
  const closeBtn = menu.querySelector('.settings-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toggleSettings();
    });
  }
}

// ============================================
// ESCAPE KEY HANDLER
// ============================================
/**
 * Handle Escape key press - closes UI in priority order
 * Returns true if something was closed
 */
export function handleEscape() {
  // Priority 1: Close dialogue panel
  const dialoguePanel = document.getElementById('dialogue-panel');
  if (dialoguePanel?.open) {
    dialoguePanel.close();
    return true;
  }
  
  // Priority 2: Close inventory panel
  const inventoryPanel = document.getElementById('inventory-panel');
  if (inventoryPanel?.open) {
    inventoryPanel.close();
    return true;
  }
  
  // Priority 3: Close character sheet
  if (panelState.characterSheet.visible) {
    toggleCharacterSheet();
    return true;
  }
  
  // Priority 4: Toggle settings menu (open if nothing else to close)
  toggleSettings();
  return true;
}

// ============================================
// PERSISTENCE
// ============================================
function savePanelState() {
  try {
    localStorage.setItem('vetuu_panels', JSON.stringify(panelState));
  } catch (e) {
    // Ignore storage errors
  }
}

export function loadPanelState() {
  try {
    const saved = localStorage.getItem('vetuu_panels');
    if (saved) {
      const data = JSON.parse(saved);
      Object.assign(panelState, data);
      restorePanelPositions();
    }
  } catch (e) {
    // Ignore storage errors
  }
}

function restorePanelPositions() {
  // Restore minimap position if undocked
  if (!panelState.minimap.docked && panelState.minimap.x !== null) {
    const el = document.getElementById('minimap-container');
    if (el) {
      el.style.left = `${panelState.minimap.x}px`;
      el.style.top = `${panelState.minimap.y}px`;
      el.style.right = 'auto';
      if (panelState.minimap.width) el.style.width = `${panelState.minimap.width}px`;
      if (panelState.minimap.height) el.style.height = `${panelState.minimap.height}px`;
      el.classList.add('undocked');
    }
    
    if (panelState.minimap.zoom !== 1) {
      updateMinimapZoom(panelState.minimap.zoom);
    }
  }
  
  // Restore quests position if undocked
  if (!panelState.quests.docked && panelState.quests.x !== null) {
    const el = document.getElementById('quest-tracker');
    if (el) {
      el.style.left = `${panelState.quests.x}px`;
      el.style.top = `${panelState.quests.y}px`;
      el.style.right = 'auto';
      if (panelState.quests.width) el.style.width = `${panelState.quests.width}px`;
      if (panelState.quests.height) el.style.height = `${panelState.quests.height}px`;
      el.classList.add('undocked');
    }
  }
  
  // Restore visibility states
  if (!panelState.minimap.visible) {
    document.getElementById('minimap-container')?.classList.add('hidden');
  }
  if (!panelState.quests.visible) {
    document.getElementById('quest-tracker')?.classList.add('hidden');
  }
}

// ============================================
// KEYBOARD SHORTCUT HINTS
// ============================================
export function getKeyboardHints() {
  return [
    { key: 'C', action: 'Character Sheet' },
    { key: 'Esc', action: 'Settings Menu' },
    { key: `${isMac() ? '⌘' : 'Ctrl'}+M`, action: 'Toggle Map' },
    { key: `${isMac() ? '⌘' : 'Ctrl'}+J`, action: 'Toggle Quests' },
    { key: 'I', action: 'Inventory' }
  ];
}

function isMac() {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

