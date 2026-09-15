# Chat session changes cap

## User flow

1. On **Chat**, pending bookmarks and file changes appear as two compact icon
   buttons in the composer context bar, immediately beside the worktree icon:
   **Bookmarks** (`data-testid="composer-bookmarks-button"`) and **Changes**
   (`data-testid="composer-changes-button"`). The old full-width cap above the
   composer is removed.
2. Each button carries its own numeric badge and is hidden when its list is
   empty. When neither list has rows, neither icon is rendered.
3. Clicking an icon opens that list in a small popover above the right side of
   the composer (`data-testid="chat-uncommitted-changes"`). Only one popover
   is open at a time. Clicking the active icon, clicking outside, or pressing
   Escape closes it.
4. The popover title describes only the active list:
   `N change`/`N changes` or `N bookmark`/`N bookmarks`.
5. **File rows:** basename + `+`/`-` from `git diff HEAD` for that path (one row per path). Click → **Chat** stays active; a **file review pane** opens on the right with inline diff (same split as Plan review). Paths **outside the session git repo** use the same pane with baseline-from-transcript diff instead of opening **Files**.
6. Items sorted **newest activity first** within each section.

## Data

- **Touched paths:** Claude completed file-edit tools register repo-relative paths in SQLite (`session_touched_paths`); membership survives commit.
- **Pending files:** Reconciled from `git diff HEAD` (and staged) per touched path; row removed when diff empty (revert, restore, or commit).
- Cap payload `sessionChangesCap.items` via `session:openReady` / `session:workspaceUpdated`.

## UI

The previous mock only covers the heavy attached cap, so
`Features/UI-Design/mocks/index.html` is updated for this case. Reuse the
existing `.context-bar-item--icon-only` dimensions and hover colors beside
`#composer-worktree-indicator`, plus `--bg-panel-raised`,
`--border-default`, `--r-md`, and `--shadow-popover` from existing composer
popovers. New selectors are `.composer-context-action`,
`.composer-context-count`, and `.chat-changes-popover`; existing
`.chat-changes-file` and diff-stat tokens remain unchanged inside the popover.

## Done criteria

- E2e in `chat-surface-core.spec.ts`: with both lists populated, both icons
  show independent counts, only the clicked list opens, switching icons
  replaces the popover, and outside-click/Escape dismiss it. Screenshot
  artifact compared against the mock.
- E2e in `secondary-panels.spec.ts`: edit, revert, git checkout cap clear, resume snapshot.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
- **Remote SSH bounds:** cap rebuild uses `wc -l`/git numstat (not bulk `cat`); at most one cap rebuild per session; background refresh serialized per devpod host; non-interactive SSH exec capped at `SSH_MAX_CONCURRENT_EXEC_PER_HOST` (6) per host via `ssh-exec.ts`.
