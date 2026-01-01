/**
 * VETUU — Dialogue Module
 * Dialogue UI, choices, effects, keyboard navigation
 */

import { hasFlag, saveGame } from './save.js';

let dialoguePanel = null;
let speakerEl = null;
let textEl = null;
let choicesEl = null;

let currentState = null;
let currentNodeId = null;
let rootNodeId = null; // The starting node of the conversation
let isOpen = false;
let selectedIndex = 0;
let choiceButtons = [];
let dialogueHistory = []; // Stack of previous node IDs for back navigation

// Track previously selected choices
const CHOICES_STORAGE_KEY = 'vetuu_dialogue_choices';
let selectedChoices = new Set();

function loadSelectedChoices() {
  try {
    const data = localStorage.getItem(CHOICES_STORAGE_KEY);
    if (data) {
      selectedChoices = new Set(JSON.parse(data));
    }
  } catch (e) {
    console.warn('Failed to load dialogue choices:', e);
  }
}

function saveSelectedChoices() {
  try {
    localStorage.setItem(CHOICES_STORAGE_KEY, JSON.stringify([...selectedChoices]));
  } catch (e) {
    console.warn('Failed to save dialogue choices:', e);
  }
}

function markChoiceSelected(nodeId, choiceIndex) {
  const key = `${nodeId}:${choiceIndex}`;
  selectedChoices.add(key);
  saveSelectedChoices();
}

function wasChoiceSelected(nodeId, choiceIndex) {
  const key = `${nodeId}:${choiceIndex}`;
  return selectedChoices.has(key);
}

// ============================================
// INITIALIZATION
// ============================================
export function initDialogue(state) {
  dialoguePanel = document.getElementById('dialogue-panel');
  speakerEl = document.getElementById('dialogue-speaker');
  textEl = document.getElementById('dialogue-text');
  choicesEl = document.getElementById('dialogue-choices');

  currentState = state;

  // Load previously selected choices
  loadSelectedChoices();

  // Add keyboard listener for dialogue navigation
  document.addEventListener('keydown', handleDialogueKey);

  // Click outside to close - clicking on the backdrop (::backdrop) closes the dialog
  // (unless dialogue is mandatory)
  if (dialoguePanel) {
    dialoguePanel.addEventListener('click', (e) => {
      // Don't allow closing mandatory dialogues by clicking outside
      if (dialoguePanel.dataset.mandatory === 'true') {
        return;
      }
      
      // Check if click was on the dialog backdrop (outside the dialog content)
      const rect = dialoguePanel.getBoundingClientRect();
      const isOutside = (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      );
      
      if (isOutside) {
        hideDialogue();
      }
    });
  }

  // Make state globally accessible for other modules
  window.__vetuuState = state;
}

// ============================================
// KEYBOARD NAVIGATION
// ============================================
function handleDialogueKey(e) {
  if (!isOpen) return;

  const code = e.code;
  const key = e.key;

  // Number keys 1-9 to select option directly
  if (key >= '1' && key <= '9') {
    e.preventDefault();
    e.stopPropagation();
    const index = parseInt(key) - 1;
    if (index < choiceButtons.length && !choiceButtons[index].disabled) {
      choiceButtons[index].click();
    }
    return;
  }

  // Tab to cycle through options
  if (code === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.shiftKey) {
      // Shift+Tab goes backwards
      selectPreviousOption();
    } else {
      selectNextOption();
    }
    return;
  }

  // Enter to confirm selected option
  if (code === 'Enter' || code === 'NumpadEnter') {
    e.preventDefault();
    e.stopPropagation();
    
    if (choiceButtons[selectedIndex] && !choiceButtons[selectedIndex].disabled) {
      choiceButtons[selectedIndex].click();
    }
    return;
  }

  // Arrow keys for navigation
  if (code === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    selectNextOption();
    return;
  }

  if (code === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    selectPreviousOption();
    return;
  }

  // Escape to close (unless dialogue is mandatory)
  if (code === 'Escape') {
    if (dialoguePanel?.dataset.mandatory === 'true') {
      return; // Can't escape mandatory dialogues
    }
    hideDialogue();
  }
}

function selectNextOption() {
  // Find next non-disabled option
  let newIndex = selectedIndex;
  let attempts = 0;
  
  do {
    newIndex = (newIndex + 1) % choiceButtons.length;
    attempts++;
  } while (choiceButtons[newIndex]?.disabled && attempts < choiceButtons.length);

  setSelectedIndex(newIndex);
}

function selectPreviousOption() {
  // Find previous non-disabled option
  let newIndex = selectedIndex;
  let attempts = 0;
  
  do {
    newIndex = (newIndex - 1 + choiceButtons.length) % choiceButtons.length;
    attempts++;
  } while (choiceButtons[newIndex]?.disabled && attempts < choiceButtons.length);

  setSelectedIndex(newIndex);
}

function setSelectedIndex(index) {
  // Remove previous highlight
  choiceButtons.forEach(btn => btn.classList.remove('selected'));
  
  // Set new selection
  selectedIndex = index;
  
  // Add highlight to new selection
  if (choiceButtons[selectedIndex]) {
    choiceButtons[selectedIndex].classList.add('selected');
    choiceButtons[selectedIndex].focus();
  }
}

// ============================================
// SHOW DIALOGUE
// ============================================
export function showDialogue(state, nodeId, _npc = null, simpleText = null) {
  currentState = state;
  currentNodeId = nodeId;
  rootNodeId = nodeId; // Remember the root for returning later
  dialogueHistory = []; // Clear history when starting new dialogue

  if (simpleText) {
    // Simple text display (signs, lore)
    speakerEl.textContent = '';
    textEl.textContent = simpleText;
    choicesEl.innerHTML = '';
    choiceButtons = [];
    currentNodeId = 'simple_text';
    rootNodeId = null; // No root for simple text

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialogue-choice';
    closeBtn.innerHTML = '<span class="choice-key">1</span> <span class="choice-text">Close</span>';
    closeBtn.addEventListener('click', hideDialogue);
    choicesEl.appendChild(closeBtn);
    choiceButtons.push(closeBtn);

    dialoguePanel.showModal();
    isOpen = true;
    selectedIndex = 0;
    setSelectedIndex(0);
    return;
  }

  // Normal dialogue node
  const node = state.dialogue.nodes[nodeId];
  if (!node) {
    console.warn('Dialogue node not found:', nodeId);
    return;
  }

  renderNode(node, nodeId, false); // false = don't add to history (it's the first node)
  dialoguePanel.showModal();
  isOpen = true;
}

// ============================================
// RENDER NODE
// ============================================
function renderNode(node, nodeId = null, addToHistory = true) {
  // Add previous node to history before changing (for back navigation)
  if (addToHistory && currentNodeId && currentNodeId !== nodeId) {
    dialogueHistory.push(currentNodeId);
  }
  
  if (nodeId) currentNodeId = nodeId;
  
  const isAtRoot = currentNodeId === rootNodeId;
  
  speakerEl.textContent = node.speaker || '';
  textEl.textContent = node.text || '';

  choicesEl.innerHTML = '';
  choiceButtons = [];
  selectedIndex = 0;

  if (!node.choices || node.choices.length === 0) {
    // End of a dialogue branch
    let keyNum = 1;
    
    // If not at root, offer to return to root instead of closing
    if (!isAtRoot && rootNodeId) {
      const returnBtn = document.createElement('button');
      returnBtn.className = 'dialogue-choice';
      returnBtn.innerHTML = `<span class="choice-key">${keyNum}</span> <span class="choice-text">Let's talk about something else</span>`;
      returnBtn.addEventListener('click', returnToRoot);
      returnBtn.addEventListener('mouseenter', () => setSelectedIndex(0));
      choicesEl.appendChild(returnBtn);
      choiceButtons.push(returnBtn);
      keyNum++;
      
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialogue-choice goodbye-option';
      closeBtn.innerHTML = `<span class="choice-key">${keyNum}</span> <span class="choice-text">See you later</span>`;
      closeBtn.addEventListener('click', hideDialogue);
      closeBtn.addEventListener('mouseenter', () => setSelectedIndex(1));
      choicesEl.appendChild(closeBtn);
      choiceButtons.push(closeBtn);
      setSelectedIndex(0); // Select return to root by default
    } else {
      // At root with no choices, just close
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialogue-choice';
      closeBtn.innerHTML = `<span class="choice-key">${keyNum}</span> <span class="choice-text">See you later</span>`;
      closeBtn.addEventListener('click', hideDialogue);
      choicesEl.appendChild(closeBtn);
      choiceButtons.push(closeBtn);
      setSelectedIndex(0);
    }
    return;
  }

  // Filter and render choices
  let visibleChoiceIndex = 0;
  
  node.choices.forEach((choice, originalIndex) => {
    // Check if this choice should be hidden
    if (shouldHideChoice(choice)) {
      return; // Skip this choice entirely
    }
    
    const btn = document.createElement('button');
    btn.className = 'dialogue-choice';
    
    // Check if this is a quest-related choice
    const isQuestChoice = hasQuestEffect(choice);
    
    // Check if this choice was previously selected
    // NEVER fade quest choices - they should always be prominent
    if (currentNodeId && wasChoiceSelected(currentNodeId, originalIndex) && !isQuestChoice) {
      btn.classList.add('previously-selected');
    }
    
    // Build the button content
    const keyNum = visibleChoiceIndex + 1;
    let content = '';
    
    // Key indicator
    if (keyNum <= 9) {
      content += `<span class="choice-key">${keyNum}</span>`;
    }
    
    // Choice text
    content += `<span class="choice-text">${choice.text}</span>`;
    
    // Quest icon (if applicable)
    if (isQuestChoice) {
      content += `<span class="choice-quest-icon" title="Quest">!</span>`;
    }
    
    btn.innerHTML = content;

    // Check requirements
    const available = checkChoiceRequirements(choice);
    btn.disabled = !available;

    // Store the original index for tracking selected choices
    btn.dataset.originalIndex = originalIndex;

    btn.addEventListener('click', () => handleChoice(choice, originalIndex));
    
    // Mouse hover should update selection
    const currentVisibleIndex = visibleChoiceIndex;
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) {
        setSelectedIndex(currentVisibleIndex);
      }
    });

    choicesEl.appendChild(btn);
    choiceButtons.push(btn);
    visibleChoiceIndex++;
  });

  // Add navigation options at the bottom (unless this is a mandatory dialogue)
  const isMandatory = node.mandatory === true;
  
  if (!isMandatory) {
    if (isAtRoot) {
      // At root: add "See you later" to close
      const goodbyeBtn = document.createElement('button');
      goodbyeBtn.className = 'dialogue-choice goodbye-option';
      goodbyeBtn.innerHTML = `<span class="choice-key">0</span> <span class="choice-text">See you later</span>`;
      goodbyeBtn.addEventListener('click', hideDialogue);
      const goodbyeIndex = choiceButtons.length;
      goodbyeBtn.addEventListener('mouseenter', () => setSelectedIndex(goodbyeIndex));
      choicesEl.appendChild(goodbyeBtn);
      choiceButtons.push(goodbyeBtn);
    } else if (dialogueHistory.length > 0) {
      // Not at root with history: add "Let's talk about something else"
      const backBtn = createBackButton(0);
      choicesEl.appendChild(backBtn);
      choiceButtons.push(backBtn);
    }
  }
  
  // Store mandatory state for preventing escape/click-outside close
  if (dialoguePanel) {
    dialoguePanel.dataset.mandatory = isMandatory ? 'true' : 'false';
  }
  
  // Re-key all buttons
  updateChoiceKeys();

  // Select first non-disabled option
  let firstAvailable = choiceButtons.findIndex(btn => !btn.disabled);
  if (firstAvailable === -1) firstAvailable = 0;
  setSelectedIndex(firstAvailable);
}

function createBackButton(keyNum) {
  const backBtn = document.createElement('button');
  backBtn.className = 'dialogue-choice back-option';
  backBtn.innerHTML = `<span class="choice-key">${keyNum}</span> <span class="choice-text">Let's talk about something else</span>`;
  backBtn.addEventListener('click', returnToRoot);
  backBtn.addEventListener('mouseenter', () => {
    const index = choiceButtons.indexOf(backBtn);
    if (index !== -1) setSelectedIndex(index);
  });
  return backBtn;
}

function updateChoiceKeys() {
  choiceButtons.forEach((btn, index) => {
    const keyEl = btn.querySelector('.choice-key');
    if (keyEl && index < 9) {
      keyEl.textContent = index + 1;
    }
  });
}

function returnToRoot() {
  if (!rootNodeId) return;
  
  // Clear history since we're going back to start
  dialogueHistory = [];
  
  const rootNode = currentState.dialogue.nodes[rootNodeId];
  if (rootNode) {
    renderNode(rootNode, rootNodeId, false);
  }
}

// Check if a choice should be hidden entirely
function shouldHideChoice(choice) {
  // If this choice gives a quest, check if we already have it
  if (choice.effects) {
    for (const effect of choice.effects) {
      if (effect.giveQuest) {
        // Hide if quest is already active or complete
        if (currentState.quests.active.includes(effect.giveQuest) ||
            currentState.quests.complete.includes(effect.giveQuest)) {
          return true;
        }
      }
    }
  }
  
  // If this choice has requirements that aren't met, hide it instead of disabling
  // (only for quest-related choices - we want to hide unavailable quests, not show them greyed)
  if (choice.requires) {
    const isQuestRelated = hasQuestEffect(choice);
    
    if (isQuestRelated) {
      // Check flag requirement
      if (choice.requires.flag && !hasFlag(currentState, choice.requires.flag)) {
        return true;
      }
      
      // Check quest complete requirement
      if (choice.requires.questComplete && 
          !currentState.quests.complete.includes(choice.requires.questComplete)) {
        return true;
      }
      
      // Check quest active requirement
      if (choice.requires.questActive && 
          !currentState.quests.active.includes(choice.requires.questActive)) {
        return true;
      }
      
      // Check quest NOT complete requirement
      if (choice.requires.questNotComplete && 
          currentState.quests.complete.includes(choice.requires.questNotComplete)) {
        return true;
      }
      
      // Check quest NOT active requirement
      if (choice.requires.questNotActive && 
          currentState.quests.active.includes(choice.requires.questNotActive)) {
        return true;
      }
    }
  }
  
  return false;
}

// Check if a choice has quest-related effects (including in child nodes)
function hasQuestEffect(choice, visited = new Set()) {
  // Direct effects on this choice
  if (choice.effects) {
    for (const effect of choice.effects) {
      if (effect.giveQuest || effect.completeQuest) {
        return true;
      }
    }
  }
  
  // Check if choice requires quest progress
  if (choice.requires?.questActive || choice.requires?.questComplete ||
      choice.requires?.questNotActive || choice.requires?.questNotComplete) {
    return true;
  }
  
  // Check child nodes recursively (if this choice leads to another node)
  if (choice.next && choice.next !== 'END' && currentState?.dialogue?.nodes) {
    // Prevent infinite loops
    if (visited.has(choice.next)) {
      return false;
    }
    visited.add(choice.next);
    
    const nextNode = currentState.dialogue.nodes[choice.next];
    if (nextNode && nextNode.choices) {
      for (const childChoice of nextNode.choices) {
        if (hasQuestEffect(childChoice, visited)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

// ============================================
// CHOICE HANDLING
// ============================================
function checkChoiceRequirements(choice) {
  if (!choice.requires) return true;

  // Flag requirement
  if (choice.requires.flag) {
    if (!hasFlag(currentState, choice.requires.flag)) return false;
  }

  // Quest complete requirement
  if (choice.requires.questComplete) {
    if (!currentState.quests.complete.includes(choice.requires.questComplete)) return false;
  }

  // Quest active requirement
  if (choice.requires.questActive) {
    if (!currentState.quests.active.includes(choice.requires.questActive)) return false;
  }
  
  // Quest NOT complete requirement (for exclusive paths or quest availability)
  if (choice.requires.questNotComplete) {
    if (currentState.quests.complete.includes(choice.requires.questNotComplete)) return false;
  }
  
  // Quest NOT active requirement (for offering new quests)
  if (choice.requires.questNotActive) {
    if (currentState.quests.active.includes(choice.requires.questNotActive)) return false;
  }

  return true;
}

async function handleChoice(choice, choiceIndex = 0) {
  // Mark this choice as selected
  if (currentNodeId) {
    markChoiceSelected(currentNodeId, choiceIndex);
  }
  
  // Apply effects
  if (choice.effects) {
    await applyEffects(choice.effects);
  }

  // Navigate to next node
  if (choice.next === 'END' || !choice.next) {
    hideDialogue();
    return;
  }

  const nextNode = currentState.dialogue.nodes[choice.next];
  if (nextNode) {
    renderNode(nextNode, choice.next, true); // true = add current node to history
  } else {
    console.warn('Next dialogue node not found:', choice.next);
    hideDialogue();
  }
}

// ============================================
// EFFECT HANDLING
// ============================================
async function applyEffects(effects) {
  const { setFlag, grantXP, addItem, showToast } = await import('./game.js');
  const { startQuest, completeQuest } = await import('./quests.js');
  const { reviveAtBase, startCorpseRun } = await import('./combat.js');

  for (const effect of effects) {
    // Set flag
    if (effect.setFlag) {
      setFlag(effect.setFlag);
    }

    // Give quest
    if (effect.giveQuest) {
      startQuest(currentState, effect.giveQuest);
    }

    // Complete quest
    if (effect.completeQuest) {
      completeQuest(currentState, effect.completeQuest);
    }

    // Give item
    if (effect.giveItem) {
      addItem(effect.giveItem, effect.amount || 1);
    }

    // Grant XP
    if (effect.grantXP) {
      grantXP(effect.grantXP);
    }

    // Open shop (placeholder)
    if (effect.openShop) {
      showToast('Shop coming soon...', 'item');
    }

    // Death/Revival: Revive at base (run to the light)
    if (effect.reviveAtBase) {
      reviveAtBase();
    }

    // Death/Revival: Start corpse run (run from the light)
    if (effect.corpseRun) {
      startCorpseRun();
    }
  }

  saveGame(currentState);
}

// ============================================
// HIDE DIALOGUE
// ============================================
export function hideDialogue() {
  if (dialoguePanel) {
    dialoguePanel.close();
  }
  isOpen = false;
  choiceButtons = [];
  selectedIndex = 0;
}

// ============================================
// STATE CHECKS
// ============================================
export function isDialogueOpen() {
  return isOpen;
}

// ============================================
// CLOSE ON ESCAPE (handled by dialog element)
// ============================================
if (typeof document !== 'undefined') {
  document.getElementById('dialogue-panel')?.addEventListener('close', () => {
    isOpen = false;
    choiceButtons = [];
    selectedIndex = 0;
  });
}
