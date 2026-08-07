# Daily note — Notes section editor (main panel)

## User flow

1. User sees a fixed **Daily note** row under sidebar **Notes** (tag: Obsidian vault).
2. Click opens the main editor (not the right-rail Timeline panel).
3. If today’s vault file is missing, the app creates it from the Obsidian template (same path as Timeline create).
4. Editor shows only the markdown body under **`## Notes`** through EOF; Timeline / Tasks / Trackers remain in Obsidian and the right rail.
5. User edits with Atomic Editor live preview; changes debounce-save into the vault file.
6. External edits to the vault file (Obsidian) reload into the editor via file watch + focus resync.
7. **← Today →** changes the viewed date and loads that day’s Notes slice.

## UI (mock reference)

`Features/UI-Design/mocks/index.html`: `#panel-daily-note`, `.daily-note-row`, `.daily-note-scope-bar`, `.daily-date-nav`, `.daily-sync-chip`, Atomic-style editor column.

## Done criteria

- Sidebar row + mutual exclusion with scratch app notes and chat sessions.
- IPC read/write Notes slice with prefix sections preserved in `raw.afterTasks`.
- Targeted e2e: open Daily note, type in editor, assert vault file `## Notes` body updated.
- `npm run build` clean; targeted e2e per `e2e/TEST_CATEGORIES.md`.
