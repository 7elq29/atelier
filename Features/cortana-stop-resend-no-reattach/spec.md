# Cortana Stop → send must not reattach and swallow the turn

## Bug

On **Update conformance dashboard** (`885dc8d5`): Stop mid-turn, then send again.
`resume()` reattached to a leftover gateway in-flight id and started a poll;
`streamInput` then hit **already polling; posting follow-up without new poll**,
so the new user message never got its own `message sent, polling snapshot`.
UI looked dead / could not send.

## Expected

1. User stops a Cortana turn.
2. User sends a new message.
3. Atelier resumes **without** reattaching to the old in-flight turn.
4. Log shows `resume skipping in-flight reattach (outbound turn)` then
   `message sent, polling snapshot` for the **new** message_id.
5. Open/startup still reattaches (quit mid-run recovery).

## Done

- [x] Outbound reconnect: `reattachInFlight: false` with `pullCompletedCortanaTurn: false`.
- [x] `interrupt` awaits gateway `/sessions/stop`.
- [x] E2E: Cortana turn → Stop → send → new poll, not follow-up-without-poll.
- [x] Affected e2e + rebuild.
