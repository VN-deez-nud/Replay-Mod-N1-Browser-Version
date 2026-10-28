# Narrow.one – Battle Log (Replays)

Record your Narrow One matches in the browser and rewatch them later as a spectator.

**Features:** free cam, pause / speed, player cycle, rename, and **export / import** of `.n1replay` files.

**Unofficial fan project.** Not affiliated with, endorsed by, or supported by Pelican Party Studios.

Inspired by the network-capture idea used in tools like [Xeltalliv/n1-replay-mod](https://github.com/Xeltalliv/n1-replay-mod).  
This build is **browser-only** (Tampermonkey + IndexedDB). No Node.js server required.

**USE IT AT YOUR OWN RISK, I WONT BE RESPONSIBLE FOR ANY SAFETY ISSUES WHICH HAPPENED WITH THIS MOD**

---

## How it works

Narrow One already streams game state over the WebSocket. This mod:

1. **Records** binary traffic while you play  
2. **Saves** it locally (IndexedDB + background / tab-close saves)  
3. **Replays** by feeding packets back into the client offline  
4. Optionally **exports** a portable `.n1replay` file you can share or archive  

Sensitive / irrelevant opcodes are skipped on record and on play. Keep the script updated when the game protocol changes.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or compatible).  
2. On Chromium, enable **Developer mode** if scripts don’t run.  
3. Create a new userscript → paste the full script → **Ctrl+S**.  
4. Open [https://narrow.one](https://narrow.one) and hard-refresh once.

You should see a **Replays** button in the left main-menu list.

---

## Recording

- Leave the script enabled and play normally.  
- Matches longer than **~15 seconds** are kept (up to **30** replays; oldest are pruned).  
- Saves run in the background (~90s idle), when the match ends, and when the tab hides/closes (when the browser allows).  
- Force-quit / mobile OS kill can still lose the last moments — stronger archival = export to `.n1replay` or use a disk-based recorder.

---

## Battle Log UI

Open **Replays** from the menu.

| Action | What it does |
|--------|----------------|
| **Watch** | Play a saved replay from this browser |
| **Rename** | Custom title (empty = date again) |
| **Export** | Download as `.n1replay` |
| **Delete** | Remove from this browser (two-step confirm) |
| **Import file** | Add a `.n1replay` into your Battle Log |
| **Watch file** | Play a `.n1replay` **without** saving it |

Leave any **live match** before watching.

---

## Controls while watching

| Key | Action |
|-----|--------|
| **P** | Pause / resume |
| **O** | Cycle speed (1× → 2× → 4× → 0.5×) |
| **L** | Skip +30 seconds |
| **N** / **B** | Next / previous player |
| **F** | Free cam on / off |
| **Esc** | Exit replay |

### Free cam

- **WASD** move · **E / Space** up · **Q** down · **Shift** faster  
- Mouse look · **Mouse wheel** change move speed  
- **F** again to return to following a player  

---

## `.n1replay` files

Portable captures for backup or sharing between browsers/PCs (anyone with this mod can open them).
