# App notes (sidebar)

## User flow

1. Sidebar **Sessions** list (agent sessions), **Terminals** section, then **Notes** after a separator.
2. **+** under Notes creates a note in SQLite and opens the main editor.
3. Editor: **Atomic Editor** (Obsidian-style live preview markdown), tab bar when 2+ open, debounced save + ⌘S. Files panel stays Monaco.
4. Top bar: editable note title; selecting a session clears note focus.
5. Row **⋯** menu: Rename, Delete (removes from SQLite; clears main editor if that note was open).
6. **Drag an app note row onto the composer** while a claude-code session is active — the note appears as an attach chip and is written to `.atelier/app-notes/<slug>.md` in the session workspace on send, referenced via `@path` (daily/weekly vault notes are not draggable).

## UI

- `global.css`: `.sidebar-lists-stack`, `.sidebar-section-hsep`, `.sidebar-list-pane`, `.files-editor-tabs`, `.attach-thumb--note`.
- Reference mock: `Documents/.../Gardenia/Features/UI-Design/mocks/index.html` (`#panel-app-notes`).

## Done

- `npm run build` clean
- `e2e/session-organization.spec.ts` app notes test
- `e2e/secondary-panels.spec.ts` (sidebar terminals + open local terminal)
