# Gardenia — Engineering Rules

This file governs how any feature or bug in this repo is planned, built, and
verified. It applies to every task, whether done directly or via a subagent.

## 0. Mandatory ordering — never skip or reorder

For **any** feature or bug, do these steps in this order. Do not write
implementation code before step 1 is written down (in the task brief, a
`Features/<NN-name>/spec.md`, or the PR description if there's no vault
entry).

1. **Clarify requirements first.**
   - **Feature**: write the expected user flow (what the user does, step by
     step) and the expected UI (what changes, referencing the exact mock —
     `Features/UI-Design/mocks/index.html` + `shared.css` — with the specific
     selector/class/token being reused). If the mock doesn't cover this case,
     say so explicitly and decide the visual treatment before coding.
   - **Bug**: reproduce it first (see §2) before touching code. A bug fix
     without a reproduction is not allowed — you cannot know it's fixed if
     you never saw it fail.
2. **Define validation/done criteria up front** (see §3) — decide what
   "done" looks like before implementing, not after.
3. Implement.
4. Run the full validation in §3 and only then call the work complete.

## 1. Environment basics

- Every command needs the repo's pinned Node version:
  `source ~/.nvm/nvm.sh && nvm use` (reads `.nvmrc`, currently `24.15.0`).
- `npm run build` — typechecks main/web configs, builds via `electron-vite`,
  and typechecks the e2e suite (`tsc -p tsconfig.e2e.json`). Must be clean
  (zero errors) before any merge.
- `npm run test:e2e` — runs the full Playwright/Electron suite (`playwright
  test`). This is the only test suite; there is no unit-test layer to
  substitute for it.
- **No mocking, ever.** Every e2e test drives the real Electron app via
  `_electron.launch({ args: ['.'], cwd: '<project-root>' })` (launch via `.`,
  not a raw script path — otherwise Electron resolves the app name as
  "Electron" and the userData dir resolution breaks) and makes a **real**
  `@anthropic-ai/claude-agent-sdk` call. There is no recording/replay/fixture
  layer anywhere in this project — don't add one.
- Work in an isolated git worktree per task/bug (`git worktree add` on a new
  branch), never directly on `main`. Run the full validation in that
  worktree before merging.

## 2. Reproducing an issue (bugs)

A reproduction is not "I read the code and think I see the bug" — it's a
concrete, re-runnable demonstration of the failure using the same tools this
project already uses for verification:

1. **Logs**: the app writes to a real log file under the userData `logs/`
   directory (see `src/main/logger.ts`, `logFilePath`/`main.log`); grep it
   for the relevant `logger.info(...)` lines instead of guessing behavior
   (see e.g. `e2e/app-shell.spec.ts`'s `main-process log file contains "app
   ready" and IPC entries` for the pattern of asserting on log content
   directly).
2. **E2E launch + test**: write (or extend) a Playwright spec under `e2e/`
   that launches the real app and drives the exact user action that triggers
   the bug — real clicks/keystrokes, a real SDK call if relevant, real
   SQLite state, a real relaunch if the bug is about persistence. The spec
   should **fail** on `main` before the fix and **pass** after. If a bug
   can't be captured as a failing e2e assertion, you don't understand it
   well enough yet to fix it.
3. **Screenshot**: capture the broken state to `e2e-artifacts/<NN-taskname>-
   <description>.png` via Playwright's `page.screenshot(...)`, matching the
   existing naming convention in `e2e-artifacts/`. Compare it against the
   mock (`Features/UI-Design/mocks/index.html`) to pin down exactly what's
   wrong visually, not just structurally.

Only after all three (log evidence, a failing e2e test, and a screenshot
showing the wrong state) confirm the same root cause should you start
implementing the fix.

## 3. Validation — definition of done

A feature or bug fix is **not complete** until all of the following pass, in
the task's own isolated worktree:

- [ ] `npm run build` is clean — zero TypeScript errors.
- [ ] `npm run test:e2e` — the **full** suite passes. A new/changed spec
      passing in isolation is not sufficient; run the whole suite to catch
      cross-feature regressions (state bleed between sessions, shared
      component regressions, etc.).
  - If a failure looks unrelated to your change, confirm it's pre-existing
    flake by rerunning that single spec file in isolation 2+ times before
    dismissing it. Currently known-flaky (timing-dependent, not caused by
    normal feature work): `chat-surface-core.spec.ts`'s "todo rail renders
    and updates live from TodoWrite" and `session-organization.spec.ts`'s
    "groups: create, drag two sessions...". Don't add to this list without
    the same isolated-rerun confirmation; don't use it as an excuse to skip
    investigating a new failure.
- [ ] Every new/changed screenshot artifact in `e2e-artifacts/` has been
      **personally viewed** (via the `Read` tool) and visually compared
      against `Features/UI-Design/mocks/index.html` — not just asserted on
      programmatically. Structural assertions (data-testid exists, CSS
      variable resolves) catch a different class of bug than a human
      actually looking at the pixels.
- [ ] For a bug: the exact e2e test/log check that reproduced it in §2 now
      passes.
- [ ] For a feature: the user flow and UI defined in step 1 have both been
      exercised end-to-end by a real e2e test — not just "the component
      renders."
- [ ] Merge conflicts (if any) are resolved **additively** — never drop one
      branch's functional contribution to make a conflict go away. Binary/
      generated artifacts (screenshots, logs in `e2e-artifacts/`) are the
      one exception: regenerate them (`git checkout --ours` or rerun the
      spec), don't hand-merge them.
- [ ] Worktree and branch cleaned up after merge.

Only once every box above is checked should a task be marked complete.
