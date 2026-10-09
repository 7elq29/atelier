# Minion — follow-up on finished task (CreateInteraction, no child)

## Problem (superseded)

Atelier used to `CreateTask` + `parent_task_id` when scratch looked
unreachable on a finished tip. That minted amnesiac child tasks (“subsession”)
while Minion UI keeps the **same** task id and uses `CreateInteraction`
(even when the DevPod is gone).

## Expected user flow (matches Minion UI)

1. User has an Atelier Minion session for a tip (running or finished).
2. Resume/reopen → same tip/active task id, history only — **no** CreateTask.
3. User types a follow-up and hits Send → **`CreateInteraction`** on the
   bound tip (or a not-yet-ready descendant in the tree). **No** child task.
4. Ready/idle follows Minion `gettask` `latest_update.display_status`
   (`COMPLETED`) or terminal `status` — not `status=RUNNING` alone, and not
   scratch DNS.

## Done when

- [x] Steer/resume Send uses `CreateInteraction` only (no scratch→CreateTask).
- [x] Busy/Working clears when `display_status` is COMPLETED.
- [x] E2E: finished tip Send does **not** show “Relaunching… New task”.
- [x] `npm run build` clean; `test:e2e:affected -- --base main` green.
