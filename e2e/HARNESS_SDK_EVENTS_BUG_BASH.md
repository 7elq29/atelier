# Harness SDK events — e2e coverage map

Run:

```bash
npx playwright test e2e/harness-sdk-events.spec.ts
```

Also run category **Chat Transcript & Composer** when changing harness UI:
`chat-surface-core.spec.ts`, `composer-core.spec.ts`.

## Automated (`harness-sdk-events.spec.ts`)

| SDK / surface | Spec test | Assertion |
|---------------|-----------|-----------|
| Init + `result` | `bootstrap: create session` | Idle composer, `token-usage` visible |
| `sdk_status` requesting | `sdk_status requesting → composer turn hint` | `composer-turn-status`; no transcript REQUEST card; clears on idle |
| Partial stream | `partial stream: assistant reply grows` | Assistant text length non-decreasing mid-turn |
| `tool_progress` | `tool_progress: tool-elapsed` | Optional `tool-elapsed` (annotated if skipped) |
| `thinking_tokens` / thinking block | `thinking_tokens: optional thinking-block` | Optional `thinking-block-card` |
| `prompt_suggestion` | `prompt_suggestion: Tab hint` | Optional `composer-suggestion-hint` |
| `local_command_output` | `local_command_output: /cost` | `local-cmd-output` visible |
| `permission_denied` / deny path | `permission_denied UI: deny Bash` | Tool `denied` or `error`; `.tool-denied` when denied |
| `model_refusal_*` | `model_refusal: optional transcript-notice` | Optional `.transcript-notice`, no `.session-banner` |
| `sdk_status` compacting | `sdk_status compacting: /compact` | Optional COMPACT card (annotated if skipped) |
| `rate_limit_event` (negative) | `rate_limit_event: no chips` | No rate-limit / send-blocked chips |
| `auth_status` (negative) | `auth_status: settings` | No `settings-auth-notice` in normal session |
| Background + `notification` (negative) | `background_tasks + monitor toast` | No background cards / toast stack |
| Hooks | `hooks: main log` | Optional `harness hook` log lines |
| `mirror_error` | `mirror_error: out of scope` | Documented only |
| `api_retry` | (via turn hint text) | Substring “Retrying API…” when event fires mid-turn |

Artifacts: `e2e-artifacts/08-harness-sdk-*.png`, `08-harness-sdk-events.log`.

## Manual only (cannot rely on SDK in CI)

| Event | Why manual |
|-------|------------|
| `api_retry` under load | Needs transient API failure |
| `rate_limit_event` rejected | Needs real quota pressure |
| `auth_status` | Needs sign-in / auth failure |
| `background_tasks_changed` + `task_*` | Needs background agent/monitor session |
| `notification` immediate | Monitor wake |
| `compact_result: failed` | Hard to force |
| `worker_shutting_down` | Subagent lifecycle |

## Log grep

```bash
grep -E 'harness event: result|sdk_status|permission_denied|local_command|harness hook|background_tasks' "$LOG"
```
