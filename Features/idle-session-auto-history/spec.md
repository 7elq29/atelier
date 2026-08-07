# Idle sessions auto-move to History

## User flow

1. An open claude-code session with **no live harness connection** this app run and status **`idle`** or **`startup-idle`** (see `SessionStatus` in `shared/session-types.ts`) is **closed automatically** — same as the user choosing Close from the row menu. It appears under the sidebar **History** section (`closed_at` set).
2. On app launch, sessions skipped for startup reconnect because `last_active_at` is older than 1 hour are auto-closed to History immediately (instead of staying in the active list as `startup-idle`).
3. During the app run, when a claude-code session becomes **`startup-idle`** (disconnected and `last_active_at` older than 1 hour), it is auto-closed to History when status is next pushed — except while startup auto-reconnect is still in flight for that session.
4. **Waiting** / **working** sessions (live harness, agent mid-turn or waiting on the user) are never auto-closed.
5. Selecting a History row and clicking **Reconnect** still reopens the session (`resumeSession`) and reconnects the harness — unchanged from manual Close today.

## UI

- No new chrome. History rows reuse the existing disconnected gate (`SessionDisconnectedPanel`, `.empty-main` pattern from `Features/UI-Design/mocks/index.html`).
- Active sidebar should not list long-disconnected / idle claude-code sessions once auto-close runs.

## Done criteria

- `markStartupIdleSessions()` auto-closes 1h+ inactive open claude-code sessions before the window opens.
- `sendStatus()` auto-closes open claude-code sessions when status would be `startup-idle`, with guards for `live` / `connecting` / `creatingWorktree` / `startupAutoReconnect`.
- `e2e/session-lifecycle.spec.ts` startup-idle case expects the session in `[data-group="history"]`, not the active list.
- Targeted e2e: `session-lifecycle.spec.ts`, `session-organization.spec.ts`; `npm run build` clean.
