# Project HQ

A console-style project dashboard for Obsidian. One full-page view with your plan, live Claude Code agents, a "needs you" list, Claude usage rings, daily metrics with sparklines, and a review inbox. Desktop only.

![screenshot](docs/screenshot.png) <!-- screenshot placeholder: add docs/screenshot.png -->

## Install
1. Clone or download this repo into `<vault>/.obsidian/plugins/project-hq` (the folder must contain `main.js`, `manifest.json` and `styles.css`).
2. In Obsidian: Settings, Community plugins, turn on Project HQ.
3. Open it from the ribbon icon or the command "Open Project HQ".

## Set up a project
Settings, Project HQ, **Add project**. Every field except the name is optional; a tile whose source is not set simply hides.

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
Any command that writes YAML frontmatter into `<daily folder>/YYYY-MM-DD.md` (local date). Project HQ shows every numeric (or boolean) key, plus `updated: <ISO time>` for the "Updated Xm ago" label.
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
