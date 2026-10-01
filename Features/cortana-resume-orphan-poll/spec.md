# Cortana resume must abort orphaned polls

## Bug

`CortanaHarness.resume()` replaces the event channel without aborting an
in-flight `sendAndPoll` loop. The old poll keeps writing to a dead channel,
and its `finally` can `polls.delete(sessionId)` while a newer turn’s abort
controller is stored under the same key — so later turns look “active” or
silently never complete (“Processing message…” forever).

Seen live on session `885dc8d5` (“Update conformance dashboard”): message sent
+ polling logged, no later `result`/`error`.

## User flow

1. User has a Cortana turn polling (or creates one with an initial prompt).
2. App relaunches / reconnects / dispatches another turn via `resume()`.
3. Expected: any prior poll is aborted; the new channel owns subsequent
   events; a new send either completes or surfaces timeout/error.
4. Actual (before fix): old poll orphans; new turn can hang with no terminal
   harness event.

## Done criteria

- [x] `resume()` aborts and clears any poll for that session before swapping
      the channel (and closes the previous channel).
- [x] `sendAndPoll` `finally` only deletes `polls` if it still owns the
      controller (identity check), so an older poll cannot wipe a newer one.
- [x] Spec + code reviewed against the live hang pattern above.
- [x] `npm run build` clean (`tsc -p tsconfig.node.json` clean after fix).
