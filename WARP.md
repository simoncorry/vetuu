# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Repository Status

Vetuu Alpha is a tile-based HTML5 game teaser set in Drycross, a desert trade outpost. The game features exploration, dialogue, quests, and light combat.

## Project Structure

```
/src
├── index.html          # Main HTML entry point
├── styles.css          # All styles (no frameworks, pure CSS)
├── /data
│   ├── map.json        # Ground tiles (base36 encoded), objects, regions
│   ├── entities.json   # NPCs, enemy spawns, bosses, player start
│   ├── dialogue.json   # Dialogue nodes and text snippets
│   ├── quests.json     # Quest definitions with objectives/rewards
│   └── items.json      # Item definitions and shop inventories
└── /js
    ├── game.js         # Main loop, state management, initialization
    ├── render.js       # DOM-based tile rendering, camera control
    ├── input.js        # Keyboard, mouse, touch input handling
    ├── collision.js    # Movement validation, object/NPC lookup
    ├── fog.js          # Fog of war with localStorage persistence
    ├── dialogue.js     # Dialogue UI and choice handling
    ├── quests.js       # Quest tracking and objective updates
    ├── combat.js       # Turn-based combat system
    └── save.js         # localStorage save/load, flags
```

## Tech Stack

- **No frameworks**: Pure HTML5, CSS, vanilla JavaScript (ES modules)
- **Rendering**: DOM-based with CSS transforms for camera
- **Animations**: CSS `steps()` for tile movement
- **Persistence**: localStorage for save data, fog mask, flags

## Commands

### Local Development

```bash
# Start a local server (any method works)
npx serve src
# or
python3 -m http.server 8000 --directory src
# or
cd src && php -S localhost:8000
```

Then open `http://localhost:8000` (or `:5000` for serve).

### No Build Step

This project has no build tooling. All files are served directly.

## Architecture Notes

### Map Encoding
- Ground tiles are base36 encoded strings (one char per tile per row)
- Decode: `parseInt(char, 36)` → lookup in `legend.tiles`

### State Management
- Single source of truth in `game.js` → `state` object
- Runtime state (enemies spawned, collected nodes) in `state.runtime`
- Flags for story progression in `state.flags`

### Collision Logic
- `tile.walkable` + `object.solid` + conditional flags (`requires`/`flagNot`)
- Act 3 blockers: solid until `dustVeilUnlocked` flag is set

### Save System
- Auto-saves to localStorage on significant events
- Fog mask saved separately (compressed bitfield)
- Export/import functions ready for cloud save integration
