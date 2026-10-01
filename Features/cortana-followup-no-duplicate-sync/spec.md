# Cortana follow-up must not re-emit the previous reply

## Bug

On **Update conformance dashboard** (`885dc8d5-…`) and any Cortana session: after a turn finishes, the next follow-up reconnects via `resume()` because the in-memory poll is gone. `reconnectHarness` saw a trailing `user` row (the **new** outbound message already written to SQLite) and called `syncCompletedTurn`, which always emits the gateway’s **last** `final_response` — i.e. the previous turn’s assistant text — before the new poll starts.

Reproduced in production DB: user at `22:46:45` → duplicate of prior assistant at `22:46:46` (same body as `22:45:31`) → then the real new turn tools. Log: `syncing completed turn after resume` with the **prior** `message_id` immediately before `message sent, polling snapshot` for the new id.

## Expected user flow

1. Cortana turn completes; assistant reply is in the transcript once.
2. User sends a follow-up (harness idle — no live poll).
3. Transcript shows the new user message, then working/tools for the **new** turn — **not** a second copy of the previous assistant reply.
4. Quit mid-turn with gateway finishing offline still syncs that missing reply once on open/startup (existing reattach/sync behavior).

## Done

- [x] Outbound `dispatchTurnToHarness` reconnect sets `pullCompletedCortanaTurn: false`.
- [x] `syncCompletedTurn` skips when trimmed final text is already in `knownAssistantContents`.
- [x] E2E: Cortana turn → idle → follow-up → no duplicate prior assistant; no `syncing completed turn after resume` on that follow-up.
- [x] `npm run test:e2e:affected -- --base main` for mapped targets.
