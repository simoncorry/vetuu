/**
 * VETUU — Quest Module
 * Quest tracking, objectives, rewards with full state machine
 * 
 * Quest States:
 *   locked    → Prerequisites not met (flag, quest, level)
 *   available → Can be accepted from NPC
 *   active    → Currently in progress
 *   complete  → Finished and rewarded
 */

import { saveGame } from './save.js';
import { renderActors } from './render.js';

let currentState = null;
let questList = null;

// ============================================
// QUEST STATE MACHINE
// ============================================

/**
 * Get the current state of a quest
 * @param {object} state - Game state
 * @param {string} questId - Quest ID
 * @returns {'locked'|'available'|'active'|'complete'}
 */
export function getQuestState(state, questId) {
  // Already complete
  if (state.quests.complete.includes(questId)) {
    return 'complete';
  }
  
  // Currently active
  if (state.quests.active.includes(questId)) {
    return 'active';
  }
  
  // Check if available (prerequisites met)
  const questDef = state.questDefs.find(q => q.id === questId);
  if (!questDef) {
    return 'locked';
  }
  
  // Check all prerequisites
  if (!checkPrerequisites(state, questDef)) {
    return 'locked';
  }
  
  return 'available';
}

/**
 * Check if all prerequisites for a quest are met
 */
function checkPrerequisites(state, questDef) {
  const req = questDef.requires;
  if (!req) return true;
  
  // Required flag
  if (req.flag && !state.flags[req.flag]) {
    return false;
  }
  
  // Required quest completion
  if (req.questComplete && !state.quests.complete.includes(req.questComplete)) {
    return false;
  }
  
  // Required player level
  if (req.level && state.player.level < req.level) {
    return false;
  }
  
  // Required multiple flags (all must be set)
  if (req.flags) {
    for (const flag of req.flags) {
      if (!state.flags[flag]) return false;
    }
  }
  
  // Required any of these flags (at least one)
  if (req.anyFlag) {
    const hasAny = req.anyFlag.some(flag => state.flags[flag]);
    if (!hasAny) return false;
  }
  
  // Required quest NOT complete (for exclusive paths)
  if (req.questNotComplete && state.quests.complete.includes(req.questNotComplete)) {
    return false;
  }
  
  return true;
}

/**
 * Get all quests in a specific state
 */
export function getQuestsByState(state, questState) {
  return state.questDefs.filter(q => getQuestState(state, q.id) === questState);
}

/**
 * Get available quests for a specific NPC
 */
export function getAvailableQuestsForNpc(state, npcId) {
  return state.questDefs.filter(q => {
    if (q.giver !== npcId) return false;
    return getQuestState(state, q.id) === 'available';
  });
}

/**
 * Get active quests that can be turned in to a specific NPC
 */
export function getCompletableQuestsForNpc(state, npcId) {
  return state.quests.active.filter(questId => {
    const questDef = state.questDefs.find(q => q.id === questId);
    if (!questDef) return false;
    
    // Check if this NPC is the turn-in target
    const lastObj = questDef.objectives[questDef.objectives.length - 1];
    if (lastObj?.type === 'return' && lastObj.toEntity === npcId) {
      // Check if all objectives complete
      return isQuestReadyToComplete(state, questId);
    }
    
    // Or if the quest giver is also the turn-in
    if (questDef.giver === npcId && !questDef.objectives.some(o => o.type === 'return')) {
      return isQuestReadyToComplete(state, questId);
    }
    
    return false;
  });
}

/**
 * Check if all objectives are complete
 */
function isQuestReadyToComplete(state, questId) {
  const questDef = state.questDefs.find(q => q.id === questId);
  if (!questDef) return false;
  
  const progress = state.quests[questId + '_progress'] || {};
  
  return questDef.objectives.every((obj, idx) => {
    if (obj.optional) return true;
    return progress[idx]?.complete;
  });
}

// ============================================
// INITIALIZATION
// ============================================
export function initQuests(state) {
  currentState = state;
  questList = document.getElementById('quest-list');
  
  // Initial render
  renderQuestTracker(state);
}

// ============================================
// START QUEST
// ============================================
export async function startQuest(state, questId) {
  const questDef = state.questDefs.find(q => q.id === questId);
  if (!questDef) {
    console.warn('Quest not found:', questId);
    return false;
  }

  // Check current state
  const questState = getQuestState(state, questId);
  if (questState !== 'available') {
    console.warn(`Cannot start quest ${questId}: state is ${questState}`);
    return false;
  }

  // Add to active
  state.quests.active.push(questId);

  // Initialize progress tracking
  state.quests[questId + '_progress'] = {};
  
  // Initialize kill counts to 0
  for (let i = 0; i < questDef.objectives.length; i++) {
    const obj = questDef.objectives[i];
    if (obj.type === 'kill') {
      state.quests[questId + '_progress'][i] = { count: 0, complete: false };
    }
  }

  // Apply onStart effects
  if (questDef.onStart) {
    const { addItem, setFlag } = await import('./game.js');
    for (const effect of questDef.onStart) {
      if (effect.giveItem) {
        addItem(effect.giveItem, effect.amount || 1);
      }
      if (effect.setFlag) {
        setFlag(effect.setFlag);
      }
    }
  }

  // Show notification
  const { showToast } = await import('./game.js');
  showToast(`Quest Started: ${questDef.name}`, 'quest');

  // Update UI
  renderQuestTracker(state);
  renderActors(state); // Update NPC quest markers

  saveGame(state);
  return true;
}

// ============================================
// UPDATE PROGRESS
// ============================================
export async function updateQuestProgress(state, type, data) {
  let anyProgress = false;
  
  for (const questId of [...state.quests.active]) { // Copy array since we might complete quests
    const questDef = state.questDefs.find(q => q.id === questId);
    if (!questDef) continue;

    const progress = state.quests[questId + '_progress'] || {};

    for (let i = 0; i < questDef.objectives.length; i++) {
      const obj = questDef.objectives[i];
      if (progress[i]?.complete) continue;

      // Kill objective
      if (type === 'kill' && obj.type === 'kill') {
        const matches = matchesKillObjective(obj, data);
        if (matches) {
          progress[i] = progress[i] || { count: 0, complete: false };
          progress[i].count++;
          progress[i].complete = progress[i].count >= obj.amount;
          anyProgress = true;
          
          if (progress[i].complete) {
            const { showToast } = await import('./game.js');
            showToast(`Objective complete: ${getKillLabel(obj)}`, 'quest');
          }
        }
      }

      // Collect objective
      if (type === 'collect' && obj.type === 'collect') {
        if (data.itemId === obj.itemId) {
          const { getItemCount } = await import('./game.js');
          const count = getItemCount(obj.itemId);
          progress[i] = { count, complete: count >= obj.amount };
          anyProgress = true;
        }
      }

      // Reach objective
      if (type === 'reach' && obj.type === 'reach') {
        // Apply map offset if needed
        const offset = state.map?.meta?.originalOffset || { x: 0, y: 0 };
        const targetX = obj.x + offset.x;
        const targetY = obj.y + offset.y;
        
        const dist = Math.hypot(data.x - targetX, data.y - targetY);
        if (dist <= (obj.radius || 3)) {
          progress[i] = { complete: true };
          anyProgress = true;
          const { showToast } = await import('./game.js');
          showToast(`Reached: ${obj.label || 'Location'}`, 'quest');
        }
      }

      // Talk objective
      if (type === 'talk' && obj.type === 'talk') {
        if (data.entityId === obj.toEntity) {
          progress[i] = { complete: true };
          anyProgress = true;
        }
      }

      // Return objective
      if (type === 'return' && obj.type === 'return') {
        if (data.entityId === obj.toEntity) {
          // Check if all prior objectives complete
          const allPriorComplete = questDef.objectives.slice(0, i).every((o, idx) => {
            if (o.optional) return true;
            return progress[idx]?.complete;
          });
          if (allPriorComplete) {
            progress[i] = { complete: true };
            anyProgress = true;
          }
        }
      }

      // Boss objective
      if (type === 'boss' && obj.type === 'boss') {
        if (data.bossId === obj.bossId) {
          progress[i] = { complete: true };
          anyProgress = true;
        }
      }
      
      // Flag objective (set via interaction or event)
      if (type === 'setFlag' && obj.type === 'setFlag') {
        if (data.flag === obj.flag) {
          progress[i] = { complete: true };
          anyProgress = true;
        }
      }
    }

    state.quests[questId + '_progress'] = progress;

    // Check if quest complete
    const allComplete = questDef.objectives.every((obj, idx) => {
      if (obj.optional) return true;
      return progress[idx]?.complete;
    });

    if (allComplete) {
      await completeQuest(state, questId);
    }
  }

  if (anyProgress) {
    renderQuestTracker(state);
    saveGame(state);
  }
}

/**
 * Check if enemy death matches a kill objective
 */
function matchesKillObjective(obj, data) {
  // If objective requires alpha, check that first
  if (obj.requireAlpha && !data.isAlpha) {
    return false;
  }
  
  // Match by enemy type (e.g., "critter", "scav", "karth_grunt")
  if (obj.enemyType && data.enemyType === obj.enemyType) {
    return true;
  }
  
  // Match by spawn ID (specific spawn point)
  if (obj.spawnId && data.spawnId === obj.spawnId) {
    return true;
  }
  
  // Match by enemy name (e.g., "Stray Critter")
  if (obj.enemyName && data.enemyName === obj.enemyName) {
    return true;
  }
  
  // Match any enemy (for generic "kill X enemies" quests)
  if (obj.any && data.enemyType) {
    return true;
  }
  
  return false;
}

/**
 * Get display label for kill objective
 */
function getKillLabel(obj) {
  if (obj.label) return obj.label;
  if (obj.enemyName) return obj.enemyName;
  if (obj.enemyType) {
    // Capitalize and format type
    return obj.enemyType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return 'Enemies';
}

// ============================================
// COMPLETE QUEST
// ============================================
export async function completeQuest(state, questId) {
  const questDef = state.questDefs.find(q => q.id === questId);
  if (!questDef) return;

  // Remove from active, add to complete
  state.quests.active = state.quests.active.filter(id => id !== questId);
  state.quests.complete.push(questId);

  // Grant rewards
  const { grantXP, addItem, showToast, setFlag } = await import('./game.js');

  if (questDef.rewards) {
    if (questDef.rewards.xp) {
      grantXP(questDef.rewards.xp);
    }
    if (questDef.rewards.items) {
      for (const item of questDef.rewards.items) {
        addItem(item.itemId, item.amount || 1);
      }
    }
    if (questDef.rewards.flags) {
      for (const flag of questDef.rewards.flags) {
        setFlag(flag);
      }
    }
    if (questDef.rewards.unlocks) {
      for (const unlock of questDef.rewards.unlocks) {
        setFlag(`unlock_${unlock}`);
      }
    }
  }

  // Apply onComplete effects
  if (questDef.onComplete) {
    for (const effect of questDef.onComplete) {
      if (effect.setFlag) {
        setFlag(effect.setFlag);
      }
    }
  }

  showToast(`Quest Complete: ${questDef.name}`, 'quest');

  // Update UI
  renderQuestTracker(state);
  renderActors(state);

  // Clean up progress data
  delete state.quests[questId + '_progress'];

  // Check if any new quests became available
  checkQuestConditions(state);

  saveGame(state);
}

// ============================================
// CHECK CONDITIONS
// ============================================
export function checkQuestConditions(state) {
  // This is called when flags change or quests complete
  // Check if any previously locked quests are now available
  const newlyAvailable = state.questDefs.filter(q => {
    const wasLocked = !state.quests.active.includes(q.id) && 
                      !state.quests.complete.includes(q.id);
    return wasLocked && getQuestState(state, q.id) === 'available';
  });
  
  // Could show notifications for newly available quests
  // For now just update UI
  renderActors(state);
  renderQuestTracker(state);
  
  return newlyAvailable;
}

// ============================================
// RENDER TRACKER
// ============================================
export function renderQuestTracker(state) {
  if (!questList) return;

  questList.innerHTML = '';

  // Show active quests
  if (state.quests.active.length === 0) {
    // Show available quests hint
    const availableQuests = getQuestsByState(state, 'available');
    if (availableQuests.length > 0) {
      questList.innerHTML = `<li class="quest-item available-hint">
        <span class="quest-name">${availableQuests.length} quest${availableQuests.length > 1 ? 's' : ''} available</span>
        <span class="quest-objective">Talk to NPCs with <span class="quest-marker">!</span></span>
      </li>`;
    } else {
      questList.innerHTML = '<li class="quest-item"><span class="quest-name">No active quests</span></li>';
    }
    return;
  }

  for (const questId of state.quests.active) {
    const questDef = state.questDefs.find(q => q.id === questId);
    if (!questDef) continue;

    const progress = state.quests[questId + '_progress'] || {};

    const li = document.createElement('li');
    li.className = 'quest-item active';

    let objectivesHtml = '';
    for (let i = 0; i < questDef.objectives.length; i++) {
      const obj = questDef.objectives[i];
      const objProgress = progress[i] || {};
      const complete = objProgress.complete;

      let label = getObjectiveLabel(state, obj, objProgress);
      objectivesHtml += `<span class="quest-objective ${complete ? 'complete' : ''}">${label}</span>`;
    }

    li.innerHTML = `
      <span class="quest-name">${questDef.name}</span>
      ${objectivesHtml}
    `;

    questList.appendChild(li);
  }
}

function getObjectiveLabel(state, obj, progress) {
  switch (obj.type) {
    case 'kill':
      const killCount = progress.count || 0;
      const killLabel = getKillLabel(obj);
      return `${killLabel}: ${killCount}/${obj.amount}`;
    
    case 'collect':
      const itemDef = state.items.find(i => i.id === obj.itemId);
      const name = itemDef?.name || obj.itemId;
      const count = progress.count || 0;
      return `${name}: ${count}/${obj.amount}`;

    case 'reach':
      return obj.label || 'Reach location';

    case 'talk':
      const npc = state.entities.npcs.find(n => n.id === obj.toEntity);
      return `Talk to ${npc?.name || 'NPC'}`;

    case 'return':
      const returnNpc = state.entities.npcs.find(n => n.id === obj.toEntity);
      return `Return to ${returnNpc?.name || 'NPC'}`;

    case 'encounter':
      return 'Survive encounter';

    case 'boss':
      const boss = state.entities.bosses.find(b => b.id === obj.bossId);
      return `Defeat ${boss?.name || 'Boss'}`;

    case 'setFlag':
      return obj.label || 'Complete objective';

    case 'giveItem':
      const giveItem = state.items.find(i => i.id === obj.itemId);
      return `Deliver ${giveItem?.name || 'item'}`;

    default:
      return obj.label || 'Complete objective';
  }
}

// ============================================
// HELPER EXPORTS FOR NPC INTERACTIONS
// ============================================

/**
 * Get quest marker type for NPC
 * @returns {'available'|'completable'|'in-progress'|null}
 */
export function getNpcQuestMarker(state, npcId) {
  // Check for completable quests first (yellow ?)
  const completable = getCompletableQuestsForNpc(state, npcId);
  if (completable.length > 0) {
    return 'completable';
  }
  
  // Check for available quests (yellow !)
  const available = getAvailableQuestsForNpc(state, npcId);
  if (available.length > 0) {
    return 'available';
  }
  
  // Check for in-progress quests (gray ?)
  const inProgress = state.quests.active.some(questId => {
    const questDef = state.questDefs.find(q => q.id === questId);
    if (!questDef) return false;
    
    // Check if any objective involves this NPC
    return questDef.objectives.some(obj => 
      (obj.type === 'talk' && obj.toEntity === npcId) ||
      (obj.type === 'return' && obj.toEntity === npcId)
    );
  });
  
  if (inProgress) {
    return 'in-progress';
  }
  
  return null;
}
