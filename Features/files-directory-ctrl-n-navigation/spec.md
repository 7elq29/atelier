# Files directory — Ctrl+N navigation

## Reproduction

1. Open a Claude Code session and select the **Files** workspace tool.
2. Open a directory in the content pane so `.files-dir-listing` contains
   multiple rows.
3. Focus the directory listing. `Ctrl+P` moves the active row upward, while
   `Ctrl+N` currently leaves it unchanged.
4. Confirm `main.log` contains the corresponding real `files:dir` entry and
   the UI contains multiple loaded rows, proving the failure occurs after the
   directory data is loaded rather than in filesystem IPC.
5. Capture the unchanged active row in
   `e2e-artifacts/bug-files-directory-ctrl-n-before.png`.

## Expected user flow and UI

With a focused Files directory listing, `Ctrl+N` moves the active selection
down one row, matching `ArrowDown`. `Ctrl+P` continues to move it up one row,
matching `ArrowUp`. Both commands stop at the first and last row.

This changes keyboard behavior only. The selected row continues to reuse the
existing `.files-dir-listing-item.active` treatment. The Files mock in
`Features/UI-Design/mocks/index.html` does not specify directory-list keyboard
shortcuts, so no new visual treatment is introduced.

## Done

- [ ] A failing E2E assertion reproduces the ignored `Ctrl+N` key.
- [ ] The Files IPC log entries and screenshot confirm the loaded broken state.
- [ ] `Ctrl+N` and `Ctrl+P` move down and up respectively.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
