# Diff — GitHub-style file tree in the changes list

## Problem

The Diff panel's left rail renders one row per changed file containing the
**full repo-relative path**. The rail is 240px wide (`.file-tree`), so anything
nested ellipsizes into uselessness — `.atelier/app-notes/ai-confor…` hides the
only part that identifies the file (its name).

## User flow

1. **Diff › Changes** (and **Diff › Commits › commit detail**, which reuses the
   same `DiffReviewBody`): the left rail shows the changed files as a
   **directory tree** instead of a flat list of full paths.
   - Directory rows: chevron + folder icon + directory name.
   - File rows: file icon + **basename only**, indented under their directory,
     with the `+N/−N` counts unchanged on the right.
   - Full path still available on hover (`title`) and as `data-path`.
2. **Single-child directory chains are compressed into one row**, GitHub-style:
   a directory whose only child is another directory (and which holds no files
   of its own) renders as `.atelier/app-notes`, not two nested rows. This is
   what keeps deep-but-narrow repos readable in 240px.
3. Directories are **expanded by default**. Clicking a directory row collapses
   it (chevron rotates, children hide); clicking again expands it. Collapse
   state is per-list and resets with the panel, matching how GitHub opens the
   Files-changed tree fully expanded.
4. Clicking a file row selects it and loads its diff on the right — unchanged.
5. Whenever the selected file changes from outside the tree (`revealChangePath`,
   or `applySummary` re-selecting after a refresh), the **collapsed ancestors of
   the new selection are expanded** so the active row is never hidden. Note:
   `revealChangePath` has no UI trigger today — `App.tsx`'s
   `openChangedFileInDiff` is currently unused (the cap routes to the review
   pane / Files tab instead), so this is a prop-contract guard, not an
   e2e-reachable flow.
6. Sort order: directories first, then files, each alphabetical.

## UI

Mock: `Features/UI-Design/mocks/index.html`.

- Diff changes list — `.file-tree` / `.ft-summary` / `.ft-item` / `.fname` /
  `.ft-counts` / `.ft-add` / `.ft-del` (mock lines 1743–1747). The mock's diff
  rows already carry a **file icon** (`#icon-file`), which the app was omitting;
  adding it brings the rail closer to the mock.
- Directory rows — `.ft-item.dir` + `#icon-folder` + `padding-left: 8 + depth*12`,
  exactly the Files-tree treatment in the mock (lines 1811–1815: depth 1 = 20px,
  depth 2 = 32px). `.ft-item.dir` color was only defined under `.files-tree`
  (`global.css:3081`); it now applies to `.file-tree` too.
- **Not covered by the mock**: the mock's Files tree has no collapse affordance,
  so the expand/collapse chevron is a new element. Visual treatment is taken
  from the existing in-app chevron convention rather than invented: the
  `ChevronDown` polyline from `ChatUncommittedChanges.tsx` at 12px in
  `--text-tertiary`, rotated -90° when collapsed with the same
  `transform 120ms ease` as `.dn-chevron` (`daily-notes.css:180`). File rows get
  a same-width spacer so icons stay in one column per depth.

## Done criteria

- `buildDiffFileTree(files)` in `src/renderer/src/utils/diffFileTree.ts`: pure
  path-grouping + single-child-chain compression, dirs-before-files sorting.
- `IconFolder` / `IconFile` extracted to `panels/tree-icons.tsx` and shared with
  `FilesPanel` instead of duplicated.
- `DiffReviewBody` renders the tree; `data-testid="diff-file-row"` stays on file
  rows (existing e2e selectors), new `data-testid="diff-file-dir"` on dir rows.
- E2e in `secondary-panels.spec.ts`: nested change shows as dir row + basename
  file row, compressed chain renders as a single `a/b/c` row, collapsing a dir
  hides its files and expanding restores them, root-level file stays at depth 0.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts` (category 10).
- Screenshots `07-diff-file-tree{,-collapsed}.png` (full window) and
  `07-diff-file-tree-rail{,-collapsed}.png` (the rail itself) viewed and
  compared to the mock.

## Validation note — category 10 is blocked before it reaches the Diff tests

`secondary-panels.spec.ts` is `mode: 'serial'`, and four of its tests fail on
**clean `main`** on this machine (each confirmed by re-running the same
selection with the source changes stashed and the app rebuilt):

1. `chat: untracked plan file appears in session changes cap` — the preceding
   `session detail: changing project path reloads diff and terminal cwd` repoints
   the session at a throwaway directory and never restores it, so every later
   test that writes into `sessionProjectPath` misses. Skipping that one test
   makes this pass.
2. `chat: plan file in cap shows Plan tag and opens review pane` — fails
   independently of (1).
3. `files panel: location bar opens nested file by absolute path` and
   `files panel: real file tree from disk…` (`files-line-comment-btn`).
4. `diff panel: real devpod session…` and `terminal-pty`'s echo test — both need
   a reachable devpod / clean PTY prompt; environmental.

Because (1) aborts the serial run before the Diff tests, the Diff and Files
tests here were run with
`--grep "setup: create a claude-code session|tab bar: switches Chat/Diff|diff panel:"`
(and the Files equivalents), which runs the same specs in order on a real app.
Fixing the project-path test's missing restore is a separate task.
