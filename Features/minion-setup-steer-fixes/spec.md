# Minion SETUP / steer — Boot until RUNNING + event-driven reply

## Bugs (Torchlight `951e7488`)

1. Live work chrome / progress treated as current while environment still booting.
2. SETUP card dropped too early (`RUNNING` + `runner_url` ⇒ no card).
3. Connect language / Connect step before pod is `STATE_RUNNING`.
4. Post-steer soft-stop after a 3‑minute timer on stale `COMPLETED`, before the
   new AGENT interaction exists.

## Correct flow

1. **SETUP** stays until `getDevpods` reports this tip’s pod as
   `STATE_RUNNING` (positive). Before that → **Boot** (or Provision if no
   DevPod hint yet). `displayStatus` keywords still win when Minion sets them.
2. **Connect** only after `STATE_RUNNING` while the agent is still linking
   (pre-agent / CONNECT display). Never map unknown/`runner_url` alone → Connect.
3. While SETUP is active: no Working “Connecting…” chrome; do not promote
   `latest_update` into the transcript as live work (history seed unchanged).
4. After `createInteraction`: wait on that user row `PENDING` → `RESPONDED`,
   then on a **new** AGENT interaction (id not yet seen). No wall-clock success
   timer. Stale tip `COMPLETED` must not soft-stop that wait. Post the agent
   text, then Done / clear chrome.

## Done

- [x] `deriveMinionSetup` Boot until `STATE_RUNNING`; no early SETUP dismiss
- [x] `awaitingSteerReply` event-driven (no wall-clock success gate)
- [x] Absent tip after `getDevpods` clears stale `lastDevpodState`
- [x] Scratch poll only when pod `STATE_RUNNING` (or scratch already healthy)
- [x] `npm run build` + `npm run test:e2e:affected -- --base main` (A/B/D green)
