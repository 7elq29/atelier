# Harness SDK events → UI

Canonical **approved** mocks: [Features/UI-Design/mocks/sdk-harness-events-review.html](../UI-Design/mocks/sdk-harness-events-review.html).  
**Draft** catalog (in review only): [sdk-harness-events.html](../UI-Design/mocks/sdk-harness-events.html) — `api_retry`, `mirror_error`.

## Goal

Normalize `@anthropic-ai/claude-agent-sdk` auxiliary messages in `claude-agent-sdk-harness.ts` → `HarnessEvent` → `SessionManager` → renderer, matching approved mock classes in `shared.css` / `global.css`.

## Out of scope (no v1 UI)

`session_state_changed`, `tool_use_summary`, `elicitation_complete`, `plugin_install`, `control_request_progress`, `files_persisted`, generic `notification` / `informational` / `conversation_reset` / `memory_recall`. Monitor wake is the only approved `notification` use.

## Shipped (verify + e2e)

| Approved mock | Status |
|---------------|--------|
| Partial stream | Harness + transcript |
| `prompt_suggestion` | Harness + Composer Tab fill |
| `thinking_tokens` | Harness + `ThinkingBlockCard` |
| `tool_progress` | Harness + `ToolCallCard` `.tool-elapsed` |

## Approved — implement

See review page threads. Key surfaces: background rail (`task_*`), monitor toast, denials/refusal notices, conversation status cards, rate limit composer chips, local slash output, settings auth notice, hook debug logs.

## Implementation tiers

1. **Background jobs + monitor toast** — `TrackerRail` cards; IPC `session:backgroundTasks`; toast stack.
2. **Denials & refusal** — `permission_denied`, `model_refusal_*`.
3. **Status & reliability** — `status`, `api_retry` text, `rate_limit_event`.
4. **Transcript & settings** — `local_command_output`, `auth_status`.
5. **Hooks** — debug log lines only.
6. **Mirror** — blocked until draft `mirror_error` approved in `sdk-harness-events.html` (no implementation).

## Done criteria

- `npm run build` clean.
- Targeted e2e per [e2e/TEST_CATEGORIES.md](../../e2e/TEST_CATEGORIES.md) for touched areas.
- Screenshot artifacts viewed against review mocks when added.

## References

- [src/main/harness/claude-agent-sdk-harness.ts](../../src/main/harness/claude-agent-sdk-harness.ts)
- [src/main/harness/types.ts](../../src/main/harness/types.ts)
- [src/main/sessions/manager.ts](../../src/main/sessions/manager.ts)
- [src/shared/harness-ui-types.ts](../../src/shared/harness-ui-types.ts)
