# HQ OS

## Requirements
- Obsidian desktop 1.4 or newer.
- Optional: [Claude Code](https://claude.com/claude-code), signed in. This powers the agent list and usage rings.
- Optional: the Claudian plugin, for the built-in chat panel (send, queue, SEND NOW, images, handoff).
- Optional, Windows only: the "now playing" track title uses `nowplaying.ps1` (PowerShell, no install needed).

## Setup
1. **Get the files.** In a terminal, open your vault folder and run:
   ```
   git clone https://github.com/hhowell116/HQ-OS.git .obsidian/plugins/project-hq
   ```
   You can also download the ZIP from GitHub and unzip it into `<vault>/.obsidian/plugins/project-hq`. The folder must hold `main.js`, `manifest.json` and `styles.css` directly (not in a subfolder).
2. **Turn it on.** Restart Obsidian, open Settings, then Community plugins. Turn off Restricted mode if asked, and enable **HQ OS**.
3. **Open it.** Click the dashboard icon in the left ribbon, or run the command **Open HQ OS**. **Command center layout** opens HQ with the chat beside it.
4. **Add a project.** Settings, HQ OS, **Add project**. Give it a name, and point it at a To-Do note (format below). Everything else is optional; tiles with no source simply hide. Projects in a `Claude'sWorkspace/<Project>/Notes/` folder are picked up automatically.
5. **Pick a look.** Choose a theme (colour wave) and switch modules on or off in Settings. The orb, visualizer and chat all follow the theme.

To update later, run `git pull` inside `.obsidian/plugins/project-hq`, then turn the plugin off and on again (or restart Obsidian).

### Troubleshooting
- **Plugin not listed:** check that `manifest.json` sits directly in `.obsidian/plugins/project-hq/`.
- **No agents or usage rings:** Claude Code isn't installed or signed in, or the Claude projects folder setting is wrong (default `~/.claude/projects`).
- **No chat panel:** install and enable Claudian, or point the chat view setting at your chat plugin.
- **Visualizer is blank:** it only shows while audio is playing.

A console-style command center for Obsidian. One full-page view with a live orb and audio visualizer, a Claude chat panel, your project plan, live Claude Code agents, a "needs you" list, Claude usage rings, daily metrics with sparklines, and a review inbox. Desktop only (Windows, macOS, Linux).

## Project settings
Settings, HQ OS, **Add project**. Every field except the name is optional; a tile whose source is not set simply hides.

| Field | What it does |
|---|---|
| To-Do note path | Plan and "Needs you" tiles |
| Next / Waiting-on headings | Heading text (prefix match). Defaults: `Next`, `Waiting on` |
| Live line regex | Matched against the first 12 lines of the To-Do note; shown as a "Live" chip |
| Agent board note | Fallback "Team board" table: `Agent / Status / Current task / Last finished / Updated` |
| Review folder | Inbox of media (mp4, webm, png, jpg, gif, pdf, md) with optional sidecar notes; Approve / Changes / Reject write frontmatter |
| Daily notes folder | Numeric frontmatter keys become Numbers tiles with sparklines |
| Metrics command + working dir | Run when today's note is missing or older than 60 minutes |
| Git repo path | Commit dots in the week strip |

Global: the Claude projects folder (default `~/.claude/projects`), a folder-exclude regex for agent scanning (default `personal`), your name (for "Waiting on <name>"), and the chat view type for the "Command center layout" command (default `claudian-view`; if it is not installed, the command just opens HQ).

Use the dropdown in the top bar to switch projects; the last one is remembered. Settings live in the plugin's `data.json` (not committed).

## To-Do note format
```
## Next
1. [ ] **Short title** then more detail
   - sub-bullet shown small under the item
2. [x] Finished item (struck through; "Clear done" moves it to a Done section)

## Waiting on
- [ ] **Thing you must do** first line only is shown
  1. steps appear on hover
```
Numbered items may look like `5c.`. Checkboxes in "Needs you" write `[x]` back to the note.

## Optional metrics script
Any command that writes YAML frontmatter into `<daily folder>/YYYY-MM-DD.md` (local date). HQ OS shows every numeric (or boolean) key, plus `updated: <ISO time>` for the "Updated Xm ago" label.
```
---
users_total: 16
apps_today: 4
updated: "2026-11-05T22:10:00.000Z"
---
```

## Notes
- Claude usage rings read the OAuth token from `~/.claude/.credentials.json` at runtime and send it only to `api.anthropic.com`. It is never stored or logged.
- Live agents are read from `~/.claude/projects/*/<session>/subagents/agent-*.meta.json` (+ `.jsonl`), last 24 hours only.

MIT licensed.

## Worker mailbox

Drop a `.md` file into `Claude'sWorkspace/Lumen/Notes/Mailbox/<sessionId>/`. HQ queues its text for that Claudian chat and deletes the file. Messages wait (shown WAITING) while the chat is busy or has background work, send once it is idle, and are re-sent if they don't show in the transcript within 20 s. This avoids Claudian's "undelivered" popup, which comes from its own mailbox discarding a message sent to a busy chat.

## GIFs and videos

The left-column animation box's ⇄ button cycles one shared list: the pixel scenes plus every `.gif`, `.mp4` and `.webm` in `gifs/` (inside the plugin folder). Names come from `gifs/index.json` (`{"file.gif": "Name"}`; a missing entry falls back to the file name). The list is rescanned on each swap, so dropping a file in is enough. The current name shows beside the arrows. Media fills the box width and its height follows the aspect ratio, capped at a third of the column, with the panels above giving way. Videos play muted and looped. Minimal mode hides GIFs and pauses videos. A file that fails to load is skipped. `gifs/add-pin.ps1 <pin url> "<Name>"` downloads a Pinterest pin (GIF, or its 720p mp4 if it is a video) and registers it.
