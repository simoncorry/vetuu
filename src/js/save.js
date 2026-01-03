/**
 * VETUU — Save Module
 * localStorage persistence for game state
 */

const SAVE_KEY = 'vetuu_save';
const FLAGS_KEY = 'vetuu_flags';

// ============================================
// FULL GAME SAVE
// ============================================
export function saveGame(state) {
  try {
    const saveData = {
      version: 1,
      timestamp: Date.now(),
      player: {
        x: state.player.x,
        y: state.player.y,
        hp: state.player.hp,
        maxHP: state.player.maxHP,
        sense: state.player.sense,
        maxSense: state.player.maxSense,
        atk: state.player.atk,
        def: state.player.def,
        luck: state.player.luck,
        level: state.player.level,
        xp: state.player.xp,
        xpToNext: state.player.xpToNext,
        inventory: state.player.inventory,
        equipment: state.player.equipment
      },
      flags: state.flags,
      quests: {
        active: state.quests.active,
        complete: state.quests.complete,
        // Save progress for active quests
        ...Object.fromEntries(
          state.quests.active.map(id => [
            id + '_progress',
            state.quests[id + '_progress'] || {}
          ])
        )
      },
      collectedNodes: Array.from(state.runtime.collectedNodes || []),
      spawnedAreas: Array.from(state.runtime.spawnedAreas || []),
      defeatedBosses: Array.from(state.runtime.defeatedBosses || [])
    };

    localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
  } catch (e) {
    console.warn('Failed to save game:', e);
  }
}

// ============================================
// LOAD GAME
// ============================================
export function loadGame() {
  try {
    const data = localStorage.getItem(SAVE_KEY);
    if (!data) return null;

    const saveData = JSON.parse(data);

    // Version check (for future migrations)
    if (saveData.version !== 1) {
      console.warn('Save version mismatch, starting fresh');
      return null;
    }

    return saveData;
  } catch (e) {
    console.warn('Failed to load game:', e);
    return null;
  }
}

// ============================================
// CLEAR SAVE
// ============================================
export function clearSave() {
  localStorage.removeItem(SAVE_KEY);
  localStorage.removeItem(FLAGS_KEY);
}

// ============================================
// FLAGS (separate for quick access)
// ============================================
export function saveFlag(flag, value) {
  try {
    const flags = loadFlags();
    if (value) {
      flags[flag] = true;
    } else {
      delete flags[flag];
    }
    localStorage.setItem(FLAGS_KEY, JSON.stringify(flags));
  } catch (e) {
    console.warn('Failed to save flag:', e);
  }
}

export function loadFlags() {
  try {
    const data = localStorage.getItem(FLAGS_KEY);
    return data ? JSON.parse(data) : {};
  } catch (e) {
    return {};
  }
}

export function hasFlag(state, flag) {
  return state?.flags?.[flag] === true;
}

// ============================================
// EXPORT/IMPORT (for cloud save future)
// ============================================
export function exportSave() {
  const save = localStorage.getItem(SAVE_KEY);
  const flags = localStorage.getItem(FLAGS_KEY);
  const fog = localStorage.getItem('vetuu_fog');

  return JSON.stringify({
    save: save ? JSON.parse(save) : null,
    flags: flags ? JSON.parse(flags) : {},
    fog: fog ? JSON.parse(fog) : null
  });
}

export function importSave(data) {
  try {
    const parsed = JSON.parse(data);

    if (parsed.save) {
      localStorage.setItem(SAVE_KEY, JSON.stringify(parsed.save));
    }
    if (parsed.flags) {
      localStorage.setItem(FLAGS_KEY, JSON.stringify(parsed.flags));
    }
    if (parsed.fog) {
      localStorage.setItem('vetuu_fog', JSON.stringify(parsed.fog));
    }

    return true;
  } catch (e) {
    console.error('Failed to import save:', e);
    return false;
  }
}

// ============================================
// AUTO-SAVE INTERVAL
// ============================================
let autoSaveInterval = null;

export function startAutoSave(state, intervalMs = 30000) {
  stopAutoSave();
  autoSaveInterval = setInterval(() => {
    saveGame(state);
  }, intervalMs);
}

export function stopAutoSave() {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }
}

