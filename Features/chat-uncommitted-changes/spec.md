# Chat session changes cap

## User flow

1. On **Chat**, when the session has pending file changes and/or session-attributed commits, a collapsible cap appears **above** the composer (`data-testid="chat-uncommitted-changes"`).
2. Header shows chevron + count of **changes** (pending files + commit rows combined).
3. **File rows:** basename + `+`/`-` from `git diff HEAD` for that path (one row per path). Click → **Diff › Changes**, select file.
4. **Commit rows:** truncated subject (no +/-). Click → **Diff › Commits**, open that commit.
5. Items sorted **newest activity first** (e.g. after edit → commit → edit again: file row for second edit + earlier commit row both visible).

## Data

- **Touched paths:** Claude completed file-edit tools register repo-relative paths in SQLite (`session_touched_paths`); membership survives commit.
- **Pending files:** Reconciled from `git diff HEAD` (and staged) per touched path; row removed when diff empty (revert, restore, or commit).
- **Session commits:** On `HEAD` advance (workspace git refresh), new commits in `oldHead..newHead` that touch a session path are stored (`session_cap_commits`). **Pull/fetch** HEAD moves are excluded via reflog heuristic.
- Cap payload `sessionChangesCap.items` via `session:openReady` / `session:workspaceUpdated`.

## UI

Mock tokens: `.chat-changes-card`, `.chat-changes-file`, `.chat-changes-commit`, `.chat-changes-add`/`.chat-changes-del`.

## Done criteria

- E2e in `secondary-panels.spec.ts`: edit, revert, commit row + navigation, edit→commit→edit, resume snapshot.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
