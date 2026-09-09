# Prevent input stalls during large workspace refreshes

## Bug

When an open workspace contains tens of thousands of changed or untracked
files, a background workspace refresh can block Atelier's Electron renderer
for several seconds. Keyboard events queue during the block, so chat and note
editor input appears frozen and then receives all typed characters at once.

## Reproduction

1. Open a real Claude Code session for a git repository containing roughly
   50,000 untracked files.
2. Wait for the initial untracked-file scan to populate the Diff workspace.
3. Trigger another real git workspace refresh while typing in the chat
   composer.
4. Observe a multi-second renderer event-loop gap while the incoming diff is
   merged with the previous diff.

Live production evidence on 2026-09-09:

- `git ls-files --others --exclude-standard` returned 52,327 paths.
- `main.log` showed recurring 15-second workspace polls and 120-second
  workspace-refresh timeouts.
- The current 52,327-entry `Array.find` merge took about 2.94 seconds in a
  focused benchmark; a path-indexed lookup took about 8 ms.

## Expected behavior

- Chat and editor input remains responsive while a large workspace diff is
  refreshed.
- Existing hydrated hunks are preserved by path.
- The complete changed-file list remains available; this fix must not
  truncate it.

## UI

There is no visual change. The UI mock
`Features/UI-Design/mocks/index.html` does not cover input latency, so no mock
selector, class, or token changes are required. The existing composer and
editor presentation must remain unchanged.

## Validation / done criteria

- A real Electron Playwright test creates a large real git workspace, performs
  repeated workspace refreshes, types into the real composer, and fails on the
  pre-fix multi-second event-loop stall.
- The same test passes after the fix and preserves the full changed-file list.
- The reproduction screenshot is personally compared with the UI mock and
  shows the unchanged composer surface.
- `npm run build` passes.
- All panel-category specs mapped from `src/main/panels/git-repository.ts`,
  `src/main/sessions/workspace-service.ts`, and
  `src/renderer/src/components/panels/DiffPanel.tsx` in
  `e2e/TEST_CATEGORIES.md` pass.
