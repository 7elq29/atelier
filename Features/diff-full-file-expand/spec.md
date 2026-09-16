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

## Compact hunk overflow behavior

### User flow

1. Open **Diff › Changes** in compact hunk mode.
2. A file whose rendered lines fit within the card has no inner horizontal
   scrollbar.
3. A file with a genuinely long line remains horizontally scrollable, and its
   scrollbar disappears again if resizing gives the line enough room.

### UI

The mock's `.diff-lines` in `Features/UI-Design/mocks/index.html` does not
declare a permanent scroll container. The app keeps the same compact card and
code-row treatment. The app measures the rendered `.diff-line` rows, avoiding
the container's polluted `scrollWidth`, and enables native horizontal
scrolling only when a row exceeds its available width by more than 2px. Its
vertical overflow remains hidden. No mock covers this threshold explicitly.

### Done criteria

- Non-overflowing `.diff-lines` use `overflow-x: hidden`.
- Genuinely long lines use `overflow-x: auto` and remain horizontally
  scrollable.
- Diff content and pane-width changes recalculate overflow state.
- A real Electron E2E assertion covers both cases and captures the compact
  non-overflowing state.
