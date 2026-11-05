# Notes editor left/right gutter

## Expected UI

Daily note and app notes Atomic editors keep a horizontal gutter from the panel
edges. Prefer `--notes-editor-inline-pad-max` (200px) on each side, but shrink
the padding symmetrically whenever the remaining content width would fall below
`--notes-editor-min-content` (480px). Same treatment for both surfaces; no mock
change (mock has no notes editor pane).

## Done

- [x] Hosts use fluid `min(pad-max, max(0, (100% - min-content) / 2))`.
- [x] E2E asserts padding respects min-content (shrinks when panel is narrow;
      200px when wide enough).
- [x] `npm run build` + daily-note notes-editor e2e pass.
