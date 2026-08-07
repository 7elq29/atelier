# Diff — expand file (full Monaco diff)

## User flow

1. **Diff › Changes** or **Diff › Commits › commit detail**: left file list selects a file; right pane shows **hunk diff** (default).
2. **Expand file** on the file header opens the **full file** in the same Monaco chrome as **Files** (syntax, minimap, gutter), **read-only**, **inline diff** (original vs modified, not side-by-side).
3. **Show hunks** returns to the compact hunk view.
4. Switching files resets to hunks for the newly selected file.

## UI

Mock: Gardenia `Features/UI-Design/mocks/index.html` — `.diff-file-expand-btn`, `.diff-area--full-file`, `.diff-full-editor` (read-only status bar).

App: reuse Files editor tokens; `.diff-area--full-file` removes padding; header keeps path + badge + toggle.

## Done criteria

- `gitFileContentPair` / `gitCommitFileContentPair` IPC for original/modified text.
- `DiffFullFileEditor` with Monaco `createDiffEditor` (`renderSideBySide: false`, `readOnly: true`).
- E2e in `secondary-panels.spec.ts`: expand → Monaco visible → show hunks.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
