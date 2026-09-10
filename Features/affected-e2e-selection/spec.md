# Affected E2E test selection

## Problem

`e2e/TEST_CATEGORIES.md` maps broad source areas to whole groups of specs.
That was intended to avoid the full suite, but the categories have grown too
coarse:

- `DailyNoteEditorPanel.tsx` maps to all eight Daily Notes specs.
- any rule in `global.css` maps to UI Chrome plus both long layout-audit specs.
- `src/main/panels/pty.ts` maps to all four Secondary Panels specs, including
  the multi-minute serial `secondary-panels.spec.ts`.
- `App.tsx` maps to multiple large categories even when a diff only changes
  one surface.

The compact Daily Note header change is a measured example: its one relevant
spec takes about 7 seconds, while category expansion launched 12 spec files,
83 tests, and several real SDK sessions, taking over five minutes before
unrelated failures and retries.

## User flow

1. Modify one or more source files on a feature branch or in the working tree.
2. Run `npm run test:e2e:affected`.
3. The command compares the selected git range plus tracked/untracked working
   changes, prints why each spec was selected, and runs only those specs.
4. Use `npm run test:e2e:affected -- --list` to inspect the selection without
   launching Electron.
5. In CI, pass `--base <ref>` (for example the PR merge base) to select from
   committed branch changes.
6. If production source is changed but no rule owns it, the command exits
   non-zero and names the unmapped file. It never silently returns “no tests.”

There is no UI change. `Features/UI-Design/mocks/index.html` does not cover
developer test tooling and remains unchanged.

## Selection model

Use `e2e/test-impact-map.json` as the source of truth:

- **Exact/component rules** map a source file or narrow directory to the
  smallest spec(s) that exercise that behavior.
- **Diff-content rules** handle shared files such as `global.css` and
  `App.tsx`. They inspect each diff hunk and map recognizable component
  selectors/tokens to focused specs.
- **Fallback rules** apply when a shared file has any hunk that no focused
  content rule owns. They intentionally select broader regression specs, so a
  mixed Daily Note + unrelated layout edit cannot be under-tested.
- A changed `e2e/*.spec.ts` always selects itself.
- docs, screenshots, feature briefs, and mock-only changes select no runtime
  tests.
- build/config/bootstrap changes use an explicit broad safety set.

The selector reports deterministic, deduplicated, lexically sorted spec paths.
It can read paths from git or from `--files` for deterministic validation.

## Done criteria

- `npm run test:e2e:affected -- --list --base d160d39 --head 982a3ec`
  selects only `e2e/daily-note-notes-editor.spec.ts` for the recent compact
  Daily Note header feature.
- A synthetic `src/main/panels/pty.ts` change selects only
  `e2e/terminal-pty.spec.ts`.
- A synthetic Daily Note selector change in `global.css` selects only the
  Daily Note editor spec.
- An unknown production source file fails with an actionable unmapped-file
  message.
- `node scripts/e2e-affected.mjs --self-test` passes.
- The selected real Daily Note spec passes.
- `npm run build` passes.
- `CLAUDE.md` and `e2e/TEST_CATEGORIES.md` direct agents to the automated
  selector; categories remain explanatory ownership documentation, not the
  executable selection mechanism.
