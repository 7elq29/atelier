# Session startup idle (skip stale auto-connect)

## User flow

1. While using the app, **last active time** updates when the user selects a **connected** session, sends a message, or clicks **Reconnect** on the disconnected gate — not when merely opening that gate, and not when launch auto-reconnects a recently-active session.
2. On app launch, **startup reconnect** runs for each open claude-code session **except** those whose last active time is more than **1 hour** ago. That auto-connect **does not** update last active — only user actions below do.
3. Those skipped sessions get live status **`startup-idle`** (sidebar dot + `data-status`). They are **not** stale — the transcript and SQLite state are intact.
4. Clicking a `startup-idle` session shows a **Session disconnected** screen in the main panel (reuse `.empty-main` centering from mocks). Chat/diff/files/terminal tabs and panels are **not** shown until reconnect.
5. The user clicks **Reconnect** on that screen. That reconnects Claude and restores the normal tab bar + chat/diff/files/terminal.
6. Sessions active within the last hour behave as today: auto reconnect on launch and the same panel preload sequence when the harness connects.

## UI

- Reuse topbar chip pattern from `connecting-pill` (`Features/UI-Design/mocks/index.html` — same `.topbar-chip` / `.btn` tokens).
- **`startup-idle`**: main panel only — `.empty-main`-style **Session disconnected** copy + primary **Reconnect** button (`.btn.btn-primary`). No tab strip, composer, or secondary panels until reconnect completes.

## Done criteria

- `last_active_at` persisted; backfilled from latest message or `created_at`.
- Relaunch with `last_active_at` &gt; 1h ago: no harness reconnect for that session; status `startup-idle`; row click shows disconnected gate (no tabs) without reconnect.
- Reconnect restores harness + preloads diff/files/terminal panels (e2e asserts panel cache mounts).
- Relaunch within 1h: existing session-lifecycle resume tests still pass.
