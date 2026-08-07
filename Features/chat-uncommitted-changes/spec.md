# Chat session file changes cap

## User flow

1. On **Chat**, when the session has at least one completed Claude file-edit tool call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`), a collapsible cap appears **above** the composer (95% width, centered), matching `Features/UI-Design/mocks/index.html` (`data-testid="chat-uncommitted-changes"`).
2. Header shows chevron + `N File(s)`; file rows show basename and `+`/`-` line stats (same rules as collapsed edit tool summaries in the transcript).
3. Clicking a file row switches to **Diff › Changes** and selects that file (loads hunks from git working tree).

## Data

- Rollups are persisted in SQLite (`session_file_edits`) and updated on each successful `tool_call_end` for file-edit tools; also backfilled from stored tool-call messages on migration.
- The cap reads `sessionFileEdits` from session workspace preload (`session:openReady` / `session:workspaceUpdated`), not from `git diff`.

## UI

Tokens/classes from mock: `.composer-stack`, `.chat-changes-card`, `.chat-changes-head`, `.chat-changes-file`, `.chat-changes-add`/`.chat-changes-del`; composer context bar unchanged inside `.composer-box`.

## Done criteria

- E2e in `secondary-panels.spec.ts`: after a real Edit tool call, cap lists the file; click file → Diff tab + selected file; row persisted in `session_file_edits`.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
