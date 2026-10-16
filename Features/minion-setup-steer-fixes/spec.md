# Minion SETUP / steer — pod-gated work + wake Boot card

## Bugs (Torchlight / Minion Task Init)

1. Live work rows (`listInteractions` / `latest_update`) while tip pod is not
   `STATE_RUNNING`.
2. SETUP / start card missing on resume or finished tip when pod is
   snapshotted / absent (`isTaskFinished` → no card).
3. Connect before pod is `STATE_RUNNING`.
4. Soft-stop before the post-steer AGENT answer is posted.
5. **Reattach empty / Boot stuck:** `softStop` ran after worker `connected`
   (idle `worker_state`) but **before** WS replay finished — tore down the
   socket + poll loop so history never arrived. Also: attach reused
   `foldHealthy` from memory and skipped `devpodStart` on a snapshotted tip.

## Correct flow

1. **SETUP / Boot** while the tip pod is **starting/restoring**, when the
   user has just steered a **sleeping** tip (wake intent), or when **attach**
   calls `devpodStart` to restore a snapshotted tip (reattach must not stay
   empty). Idle sleeping with no wake / no attach-wake → **no** SETUP card.
   Provision only when there is no DevPod hint yet. Connect only after
   worker handshake (`workerLinked`), not merely `STATE_RUNNING`.
2. **No new live work** unless pod is `STATE_RUNNING`: absorb
   `latest_update` + agent interaction text into dedupe sets without transcript
   rows. Exception: the AGENT answer (or elicitation) for the in-flight steer
   after user row `RESPONDED` — always post that.
3. Scratch tools only when `STATE_RUNNING` (or scratch already healthy).
4. Soft-stop only when not awaiting a steer reply, **and** not while a worker
   socket is still dialing / replaying (`!foldHealthy` or `!setupComplete`).
   Soft-stop must not kill an in-flight socket when SETUP is still showing.
5. Cold **attach** always treats the EventChannel as empty: clear
   `foldHealthy` / force `resetOnConnect`, and always wake sleeping tips
   (do not skip wake because a prior live session remembered `foldHealthy`).

## Validation

- [x] Reattach / Case D: history (tools) visible; SETUP advances Boot → Connect → dismiss
- [x] Sleeping tip attach: Boot until worker linked (SETUP evidence e2e)
- [x] `npm run build`
- [x] `e2e/minion-session.spec.ts` A/B/D + SETUP evidence green
- [ ] Full `test:e2e:affected -- --base main` — remaining failures are
      `initial-prompt` missing on Claude/Cortana New Session modal (post
      `06fb2ef9` redesign), not Minion SETUP; confirmed in isolation 2×

## Done

- [x] `deriveMinionSetup` Boot for starting/wake; sleeping idle → no card
- [x] Live work gated on `STATE_RUNNING`; steer answer exempt
- [x] softStop preserves Boot only while starting / wake intent
- [x] Cold seed fetches `getDevpods` before SETUP chrome
- [x] Defer softStop until fold/SETUP complete; don't kill mid-replay socket
- [x] Attach clears stale foldHealthy; wake sleeping tip even if memory says folded
- [x] Minion e2e A/B/D + SETUP evidence green
