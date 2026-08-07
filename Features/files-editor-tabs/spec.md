# Files editor tabs

## User flow

1. In the **Files** session tab, clicking a file in the tree (or committing a path in the location bar, or opening via quick-open / chat link) **loads that file in the current tab** (replacing its path). The first open creates the first tab.
2. Multiple editor tabs can be open; **+** **duplicates the current tab** (same file, new tab entry). Duplicate tabs share the same Monaco buffer for the same path.
3. Tab strip above the tree/editor split: basename, dirty dot, × to close; click a tab to switch.
5. Closing the active tab selects the neighbor tab; closing the last tab returns to the empty “Select a file to edit” state.

## UI

Mock (`Features/UI-Design/mocks/index.html`) does **not** yet show editor tabs; treatment follows secondary-panel patterns: `files-editor-tabs` / `files-editor-tab` (active state like `.diff-sub-tabs button.active`), close control and dirty indicator using existing `--text-tertiary` / `--bg-active` tokens from `global.css`.

## Done criteria

- Tab open/switch/close/dirty indicator behavior in `FilesPanel.tsx`.
- E2e in `secondary-panels.spec.ts`: two files → two tabs, switch content, close tab.
- `npm run build` clean; targeted `secondary-panels.spec.ts` pass.
