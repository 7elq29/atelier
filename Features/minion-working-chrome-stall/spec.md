# Bug: Minion Working / tool cards never update during a live run

## Reproduction (Including metric/tracing conformance, 2026-10-07)

1. Follow-up CreateTask → child RUNNING; Minion web shows Run / Skill / Agent.
2. Atelier stays on “waiting for tools” (or blank after Done) — no `Running Bash`,
   no tool cards — then jumps to the final answer.

## Root causes (fixed in harness)

1. Scratch `sizeBytes` / `modifiedTimeUnix` returned as strings → skip-fetch forever.
2. Same-tip steer left `completionPosted` true → Working chrome no-op.
3. Wait-chrome detector missed “waiting for tools” placeholder.
4. Scratch `fetch` had no timeout (could stall gettask polling).
5. `latest_update.display_status=COMPLETED` while `task.status` still RUNNING →
   never posted Done / never flushed scratch (e2e hung or bare Done).
6. Scratch DNS lags name/URL/`RUNNING` → flush retries before Done so tool
   cards can land; dedicated scratch poll so gettask cannot starve tools.

## E2E plan (A / B / D — C parked)

### Case A — New session full loop
Create → SETUP → intermediate (Working `Running…` and/or `tool-card` /
`tool-sequence-summary` after collapse) **before** Done → assistant answer →
follow-up → intermediate again → second answer.

### Case B — Self-seed attach history (no pinned fixture)
Create until rich intermediate + answer → **close Atelier session without
canceltask** (DevPod stays) → attach same task id → ≥1 seeded tool-card →
follow-up → intermediate → answer. Do not rely on a pinned tip whose pod
may already be gone.

### Case C — Dead tip / must CreateTask — **PARKED**
Invalid until e2e can **prove** DevPod/scratch unreachable (create→cancel→poll
scratch fail, or equivalent). Do not assume a pinned cancelled id is pod-gone.

### Case D — Attach existing (identity + history)
Attach/focus same UUID → one Minion row, no twin “spinning up” → history
visible (prior transcript and/or seeded tool-cards).

## Done criteria

- [x] Harness fixes above.
- [x] E2E implements A, B, D as specified; C absent or `test.skip` with reason.
- [x] `npm run build` clean; `npm run test:e2e:affected -- --base main` green
      (selector → `e2e/minion-session.spec.ts` only; 3 passed).
- [x] New/changed screenshots captured under `e2e-artifacts/minion-case-*`
      (A setup/intermediate/answer/follow-up; B seeded/history/follow-up; D history/reattach).
