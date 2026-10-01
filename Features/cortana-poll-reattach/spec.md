# Cortana poll reattach after relaunch / mid-turn follow-up

## Bug

After Atelier relaunches (or otherwise drops in-memory `CortanaHarness` polls), a gateway turn can still be running. Selecting the session or sending a follow-up calls `resume()` then `streamInput()`, which POSTs a **new** async `message_id` and polls for `assistant` with that id. Cortana finishes under the **original** turn id (`final_response` / assistant history), so Atelier stays pending until the 30‑minute poll timeout.

Reproduced on session `885dc8d5-…` (Update conformance dashboard): poll for `308a3068-…` while gateway completed under `4b58c8f2-…`.

## Expected user flow

1. User starts a Cortana turn that takes a while.
2. App relaunches (upgrade, quit/reopen) while the turn is still running on the gateway.
3. User re-selects the session (and optionally sends a follow-up like “what's the progress?”).
4. Atelier reattaches to the **in-flight** gateway `message_id`, shows working, then goes idle when `final_response` / matching assistant arrives.
5. A follow-up sent while that poll is live is POSTed to the gateway but does **not** start a second poll keyed to a new id.

## Done criteria

- [x] `resume()` fetches snapshot and, if any `message_id` has execution events without `final_response`, starts polling that id (no new create/async).
- [x] Poll completes on assistant with tracked id **or** a **new** `final_response` since poll start.
- [x] `streamInput` while already polling does not start a second poll.
- [x] E2E: Cortana send → relaunch mid-flight → select (+ optional follow-up) → session leaves working and shows the assistant reply (not stuck pending).
- [x] `npm run test:e2e:affected -- --base main` passes for mapped targets.
