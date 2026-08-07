# Composer per session (chat keep-alive)

## User flow

1. User opens multiple claude-code sessions and switches between them in the sidebar.
2. Each visited session keeps its own composer (draft text, uncommitted-changes cap, branch context) without refetch flicker on switch.
3. Model/effort and message queue are scoped to the session that owns them; switching sessions does not clear another session’s queue.
4. Diff/Files “add to composer” and ESC-restore-after-interrupt target the **active** session’s composer.

## UI

Same composer layout as today (`.composer-wrap` / `.composer-stack` in chat tab). Inactive session composers stay mounted with `.composer-cache-entry` hidden (same visibility pattern as terminal keep-alive).

## Done criteria

- `aliveChatComposers` registers on first visit to a connected claude-code session; evicted on session delete.
- One `<Composer>` per registered session; only the active session’s entry visible on Chat tab.
- Per-session `queuedMessages` and composer refs; no global `modelSelection` in App (read from session + local override per id).
- `ChatUncommittedChanges` polls only when that session’s composer is visible on Chat.
- `npm run build` clean; targeted e2e: `composer-core.spec.ts`, `composer-mentions-and-commands.spec.ts`, `session-lifecycle.spec.ts` (draft preserved across session switch).
