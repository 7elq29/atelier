# Minion — follow-up on finished task relaunches DevPod

## Problem

Sending a message on a completed/cancelled Minion job called
`CreateInteraction` on the dead task. The message sat `PENDING`, no DevPod
came back, and the composer stayed stuck on Stop.

## Expected user flow

1. User has an Atelier Minion session for a finished or cancelled task
   (attach or after the job ends).
2. User types a follow-up and hits Send.
3. Atelier creates a **new** Minion task with `parent_task_id` = the prior
   task (same-artifact / context follow-up) and the follow-up text as the
   prompt — this spins a **new DevPod**.
4. Same Atelier chat continues; transcript shows a short relaunch note.
5. **SETUP** card (Provision → Boot → Connect) appears while the new
   DevPod comes up — same chrome as a fresh create.
6. Once connected, Working / tool progress continues as usual.
7. Stop cancels the **active** (child) task.

While the remote job is still running, follow-ups stay on
`CreateInteraction` (steer), unchanged.

## Done when

- [x] Terminal-task Send uses `CreateTask` + `parent_task_id`, not
      `CreateInteraction` alone
- [x] SETUP chrome shows during relaunch
- [x] Composer Stop tracks the new running job; clears when it finishes
- [x] E2E: attach cancelled/completed → send → setup card (or relaunch ack)
- [x] `npm run build` clean; minion-session e2e green
  (`test:e2e:affected` also selects unrelated Claude specs via `manager.ts`
  ownership — those failures are pre-existing / env, not this change)
