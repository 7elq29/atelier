# Files tab — keyboard hints on directories and files

## User flow

1. User opens a **claude-code** session and switches to the **Files** tab
   (click or existing **⌘+f** while hints are active).
2. User **holds ⌘**. Letter badges appear on visible **directory** and **file**
   rows in the Files tree, using the same overlay as other chrome
   (`.keyboard-hint-badge` from `Features/keyboard-hints/spec.md` /
   `Features/UI-Design/mocks` tokens `--accent`, `--bg-panel`, `--text-primary`,
   `--r-sm`, `--font-mono`). The mock Files tree (`.files-tree .ft-item`) has
   no dedicated badge art; we reuse the live hint overlay rather than inventing
   a new Files-only treatment.
3. While still holding ⌘, the user types the badge. A **directory** expands or
   collapses (same as click). A **file** opens in the Files editor (same as click).
4. Releasing ⌘ dismisses badges. Hidden Files panels (Chat/Diff selected, keep-alive
   `display: none`) are not labeled.

Monaco stays `data-hint-exclude-root` so editor internals are not hint targets.

## Done criteria

- Hold ⌘ on the Files tab assigns `data-keyboard-hint-label` to visible
  `file-tree-dir` and `file-tree-file` rows.
- Activating a file hint opens that file; activating a directory hint toggles it.
- `npm run build` clean; targeted e2e in `secondary-panels.spec.ts` plus the
  keyboard-hint specs that share overlay behavior.
