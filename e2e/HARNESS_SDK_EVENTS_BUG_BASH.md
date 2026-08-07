# Harness SDK events — bug bash matrix

Companion to `e2e/harness-sdk-events.spec.ts` and `Features/harness-sdk-events/spec.md`.
Run automated slice:

```bash
npx playwright test e2e/harness-sdk-events.spec.ts
```

Also run category **Chat Transcript & Composer** (`chat-surface-core.spec.ts`, `composer-core.spec.ts`) after harness changes.

## Automated in `harness-sdk-events.spec.ts`

| Surface | Assertion |
|--------|-----------|
| Turn idle after bootstrap | `composer-turn-status` hidden, Send visible |
| In-flight turn | `composer-turn-status` + Stop; no `conversation-status-card[data-status-kind=requesting]` |
| Turn completes | hint clears; still no REQUEST transcript card |
| `tool_progress` | Best-effort `tool-elapsed` on 5s Bash (SDK-dependent) |
| Background tasks | No transcript/rail cards when SDK sends no tasks |
| Monitor toast | No `sdk-toast-stack` without notification events |

Artifacts: `e2e-artifacts/08-harness-sdk-*.png`, `08-harness-sdk-events.log` (grep harness IPC lines).

## Manual / session-specific (checklist)

Use a long-running local session; watch **transcript**, **composer footer**, **tracker rail**, **Settings → Agent**, and `main.log`.

| SDK / event | What to verify | Pass criteria |
|-------------|----------------|---------------|
| `prompt_suggestion` | Empty composer while suggestion active | Placeholder shows suggestion; **Tab to fill** hint (10px); Tab fills, does not send |
| Partial stream / thinking | Extended thinking model | `thinking-block-card` streams or shows token estimate; not duplicated as REQUEST card |
| `status: compacting` | Trigger auto-compact or `/compact` | Transcript **COMPACT** card + progress bar; clears when compact finishes |
| `compact_result: failed` | Force compact failure if reproducible | Failed COMPACT card + `compact_error` meta; not stuck REQUEST |
| `api_retry` | Network blip / retry | **Retrying API…** in composer hint (not transcript card) |
| `rate_limit_event` | Heavy usage if hit | Composer `.composer-status-chip` warn + **Send blocked**; send disabled |
| `permission_denied` | Deny a tool in permission card | Tool row `.tool-denied` / status **denied** |
| `model_refusal_*` | Refusal-triggering prompt | `.transcript-notice` warning/danger (not session banner) |
| `local_command_output` | `/cost` or `/usage` | `.local-cmd-output` monospace block in transcript |
| `auth_status` | Sign-in / auth errors | Settings **Auth** notice only (`.settings-auth-notice`) |
| `background_tasks_changed` + `task_*` | Background agent/monitor if used | Tracker rail **Monitors / Subagents / Shell**; transcript background card when tasks live |
| `notification` (immediate) | Monitor wake | `sdk-toast` with priority border; dedupe by key |
| Hooks | Dev build | `harness hook` lines in `main.log`; optional `.sdk-debug-log` in dev |
| `mirror_error` | **Out of scope** until draft approved | No UI yet |

## Regressions to watch

1. **REQUEST stuck** — composer hint remains after Send returns (turn ended but `session:sdkChrome` or `busy` stale).
2. **REQUEST in transcript** — large `.conversation-status-card--requesting` in chat body (should be composer hint only).
3. **Double busy chrome** — footer Working pill + hint (hint only expected today).
4. **Compact vs REQUEST** — compacting shows transcript card; normal turns do not.
5. **Rate limit** — chips without blocking send when only warning; block when rejected.

## Log grep (during manual pass)

```bash
grep -E 'harness event: result|session:turnState|sdk_status|permission_denied|background_tasks|harness hook' "$LOG"
```
