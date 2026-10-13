# Minion SETUP / steer — pod-gated work + wake Boot card

## Bugs (Torchlight / Minion Task Init)

1. Live work rows (`listInteractions` / `latest_update`) while tip pod is not
   `STATE_RUNNING`.
2. SETUP / start card missing on resume or finished tip when pod is
   snapshotted / absent (`isTaskFinished` → no card).
3. Connect before pod is `STATE_RUNNING`.
4. Soft-stop before the post-steer AGENT answer is posted.

## Correct flow

1. **SETUP / Boot** whenever tip pod is not positively `STATE_RUNNING`
   (including finished/COMPLETED tips that need a wake) — Provision only when
   there is no DevPod hint yet. Connect only after `STATE_RUNNING` while linking.
2. **No new live work** unless pod is `STATE_RUNNING`: absorb
   `latest_update` + agent interaction text into dedupe sets without transcript
   rows. Exception: the AGENT answer (or elicitation) for the in-flight steer
   after user row `RESPONDED` — always post that.
3. Scratch tools only when `STATE_RUNNING` (or scratch already healthy).
4. Soft-stop only when not awaiting a steer reply. If soft-stopping while pod
   is not running, **keep** the Boot SETUP card (do not clear chrome).

## Done

- [x] `deriveMinionSetup` shows Boot when pod not `STATE_RUNNING` even if tip finished
- [x] Live work gated on `STATE_RUNNING`; steer answer exempt
- [x] softStop preserves wake Boot card
- [x] Cold seed fetches `getDevpods` before SETUP chrome
- [x] `npm run build` + `npm run test:e2e:affected -- --base main` (A/B/D green)
