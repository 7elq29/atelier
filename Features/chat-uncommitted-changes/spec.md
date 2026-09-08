# Chat session changes cap

## User flow

1. On **Chat**, when the session has pending file changes or bookmarks, a cap appears **above** the composer (`data-testid="chat-uncommitted-changes"`).
2. The cap holds **two independently expandable sections**, in this order: **Bookmarks**
   (`data-testid="chat-changes-bookmarks"`) then **Changes** (`data-testid="chat-changes-files"`).
   Each has its own chevron + count and its own collapsed state — expanding or collapsing one
   never changes the other. Both start collapsed. A section with no rows is not rendered at all;
   when neither has rows the whole cap is hidden.
3. Header text describes only that section's own rows: `N change`/`N changes` and
   `N bookmark`/`N bookmarks`.
4. **File rows:** basename + `+`/`-` from `git diff HEAD` for that path (one row per path). Click → **Chat** stays active; a **file review pane** opens on the right with inline diff (same split as Plan review). Paths **outside the session git repo** use the same pane with baseline-from-transcript diff instead of opening **Files**.
5. Items sorted **newest activity first** within each section.

## Data

- **Touched paths:** Claude completed file-edit tools register repo-relative paths in SQLite (`session_touched_paths`); membership survives commit.
- **Pending files:** Reconciled from `git diff HEAD` (and staged) per touched path; row removed when diff empty (revert, restore, or commit).
- Cap payload `sessionChangesCap.items` via `session:openReady` / `session:workspaceUpdated`.

## UI

Mock tokens: `.chat-changes-card`, `.chat-changes-section`, `.chat-changes-head`,
`.chat-changes-toggle`, `.chat-changes-body`, `.chat-changes-file`,
`.chat-changes-add`/`.chat-changes-del`. Each section owns one `.chat-changes-head` +
`.chat-changes-body`; the collapsed class moves from the card to `.chat-changes-section`, and
adjacent sections are separated by a `--border-subtle` hairline.

## Done criteria

- E2e in `chat-surface-core.spec.ts`: with both sections populated, collapsing Changes leaves
  Bookmarks expanded and vice versa, each header counts only its own rows, and Bookmarks
  renders above Changes. Screenshot artifact compared against the mock.
- E2e in `secondary-panels.spec.ts`: edit, revert, git checkout cap clear, resume snapshot.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
- **Remote SSH bounds:** cap rebuild uses `wc -l`/git numstat (not bulk `cat`); at most one cap rebuild per session; background refresh serialized per devpod host; non-interactive SSH exec capped at `SSH_MAX_CONCURRENT_EXEC_PER_HOST` (6) per host via `ssh-exec.ts`.
