# Message queue: auto-run after cancel

## Bug

While turn m1 is in flight, the user queues m2 (visible in `.queued-strip`). Canceling/stopping m1 should start m2 automatically. Instead m2 either stays stuck in the strip or appears in chat with no harness turn.

## Root cause

Stop closes the Claude SDK input queue but leaves the session map entry until `pump()` finishes. Immediately after, the terminal `result` (still allowed through while `interruptRequested`) calls `drainTurnQueue`, which takes the `streamInput` fast path because `isActive()` is still true — push to a closed queue is a silent no-op. The following `interrupted` event then clears `inflightId` without a real dispatch.

## User flow (expected)

1. User sends m1; Stop is visible (turn in flight).
2. User types m2 and sends; `.queued-strip` shows m2 (not yet in the transcript DB).
3. User clicks Stop (or double-ESC) to cancel m1.
4. m2 leaves the strip, appears as a user message in chat, and the harness starts a new turn for m2 without another Send.

## UI

Existing composer queue strip (`.queued-strip` / `data-testid="queued-strip"`) from the message-queue design — no new chrome. After cancel, strip empties as m2 is drained into the transcript.

## Done criteria

- [x] Stopping an in-flight turn with a non-empty turn queue drains and dispatches the next item (log: `turnQueue: draining next queued message`).
- [x] Dispatch after interrupt reconnects (or otherwise delivers input) — not a silent `streamInput` onto a closed queue (`isActive` false once interrupt/close has begun).
- [x] `result` while `live.interruptRequested` does not drain; `interrupted` owns drain.
- [x] E2E: queue m2 mid-turn → Stop → m2 in DB + drain log + assistant progress on m2.
- [x] `npm run build` clean; targeted `e2e/message-queue-interrupt-drain.spec.ts` green (affected suite also selects unrelated WIP on this worktree).
