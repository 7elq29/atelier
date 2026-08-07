# Chat uncommitted changes cap

## User flow

1. On **Chat**, when the session workspace has a git repo with uncommitted changes, a collapsible cap appears **above** the composer (95% width, centered), matching `Features/UI-Design/mocks/index.html` (`data-testid="chat-uncommitted-changes"`).
2. Header shows chevron + `N File(s)`; file rows show basename and `+`/`-` counts (no per-file icons, no Review button).
3. Clicking a file row switches to **Diff › Changes** and selects that file (loads hunks).

## UI

Tokens/classes from mock: `.composer-stack`, `.chat-changes-card`, `.chat-changes-head`, `.chat-changes-file`, `.chat-changes-add`/`.chat-changes-del`; composer context bar unchanged inside `.composer-box`.

## Done criteria

- Changes list comes from **session workspace preload** (`session:openReady` / `session:workspaceUpdated`); no renderer poll interval.
- E2e in `secondary-panels.spec.ts`: cap visible on fixture repo chat; click file → Diff tab + selected file.
- `npm run build` clean; targeted `e2e/secondary-panels.spec.ts`.
