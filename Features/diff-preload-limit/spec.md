# Diff preload — hydrate at most ten files

## User flow

1. A user opens or reconnects a Claude Code session whose Git working tree has uncommitted files.
2. Atelier's background workspace preload always returns the complete changed-file list, branch,
   and per-file addition/deletion counts.
3. Atelier eagerly loads patch hunks for at most the first **10** changed files. If the working
   tree has ten files or fewer, behavior is unchanged.
4. Files after the first ten remain visible and selectable in Diff → Changes with empty hunks in
   the workspace snapshot.
5. Clicking any file whose hunks were not preloaded calls the existing per-file `gitFileDiff` IPC,
   renders that file's hunks, and caches them for later selection.

## UI

- No new UI is introduced. The complete file tree and selected-file diff continue to match
  `Features/UI-Design/mocks/index.html` Diff → Changes markup: `.file-tree`, `.ft-item`,
  `.diff-area`, and `.diff-file-card`.
- The limit is intentionally invisible: it reduces startup/background work without truncating the
  file list or adding a "load more" interaction.

## Implementation constraints

- Define one shared main-process preload limit of `10`.
- Apply the limit only when workspace preload hydrates working-tree hunks. Explicit per-file opens
  remain uncapped. Other callers of full hunk hydration retain their existing behavior.
- Preserve all file stubs in `DiffSummary.files`; only `hunks` hydration is capped.
- Log both total changed files and eagerly hydrated files so production behavior is diagnosable.

## Done criteria

- A real Electron E2E creates a real Git repository with 12 modified tracked files and a real
  Claude Code session.
- The E2E verifies all 12 files reach the workspace snapshot, no more than 10 have eager hunks,
  an eleventh file starts unhydrated, and clicking it loads and displays its patch.
- The E2E verifies `main.log` records the total and hydrated counts, and captures the Diff panel
  after the lazy file opens.
- `npm run build` is clean.
- Run every mapped Secondary Panels spec from `e2e/TEST_CATEGORIES.md`.
