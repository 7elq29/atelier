# Minion SETUP stuck on Connecting while session is running

## Bug

SETUP card stays on **Connecting to DevPod…** / Connect step while the
transcript already shows live tool calls (session is connected and working).

## Cause

`completeStartup` (dismisses SETUP) only ran on user turns, assistant text, or
non-create replay. Live **tool** events (WS fold) and **scratch** tool streams
did not dismiss SETUP — so Connect stayed painted while tools already ran.
Create also skipped `onState(live)` completeStartup until fold was healthy.

## Expected

Once the worker socket is **live** (or linked + live fold/scratch work arrives),
dismiss SETUP and show Working. Never leave Connecting over an already-running
turn.

## Done

- [x] Live fold work after `workerLinked` calls `completeStartup` (+ Working paint).
- [x] Scratch live tools after `workerLinked` call `completeStartup`.
- [x] `onState(live)` always completes startup (create + attach).
- [x] Case A asserts SETUP gone once intermediate tools are visible.
- [x] SETUP evidence (create) e2e passes; build clean.
