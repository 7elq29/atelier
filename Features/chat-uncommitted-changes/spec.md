# Chat session changes cap

## User flow

1. On **Chat**, when the session has pending file changes, a collapsible cap appears **above** the composer (`data-testid="chat-uncommitted-changes"`).
2. Header shows chevron + count of pending file rows.
3. **File rows:** basename + `+`/`-` from `git diff HEAD` for that path (one row per path). Click → **Chat** stays active; a **file review pane** opens on the right with inline diff (same split as Plan review). Paths **outside the session git repo** use the same pane with baseline-from-transcript diff instead of opening **Files**.
4. Items sorted **newest activity first**.

## Data

- **Touched paths:** Claude completed file-edit tools register repo-relative paths in SQLite (`session_touched_paths`); membership survives commit.
- **Pending files:** Reconciled from `git diff HEAD` (and staged) per touched path; row removed when diff empty (revert, restore, or commit).
- Cap payload `sessionChangesCap.items` via `session:openReady` / `session:workspaceUpdated`.

## UI

Mock tokens: `.chat-changes-card`, `.chat-changes-file`, `.chat-changes-add`/`.chat-changes-del`.

## Done criteria

- E2e in `secondary-panels.spec.ts`: edit, revert, git checkout cap clear, resume snapshot.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
- **Remote SSH bounds:** cap rebuild uses `wc -l`/git numstat (not bulk `cat`); at most one cap rebuild per session; background refresh serialized per devpod host; non-interactive SSH exec capped at `SSH_MAX_CONCURRENT_EXEC_PER_HOST` (6) per host via `ssh-exec.ts`.
