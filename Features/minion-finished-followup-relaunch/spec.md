# Minion — follow-up / resume on finished tip (CreateInteraction)

## Problem (superseded)

Atelier used to `CreateTask` + `parent_task_id` when scratch looked
unreachable on a finished tip. That minted amnesiac child tasks (“subsession”)
while Minion UI keeps the **same** task id and uses HTTP `createInteraction`
(even when the DevPod is gone).

## Expected user flow (matches Minion UI)

1. User has an Atelier Minion session for a tip (running or finished/cancelled).
2. Resume/reopen → same tip id, history only — **no** CreateTask.
3. Send → **`POST /api/createInteraction`** on the tip (or live descendant).
4. Use the response: store `interaction.id`, expect `INTERACTION_STATUS_PENDING`.
5. Poll `listInteractions` until that user row is `RESPONDED` (ack in
   `response` / `responseContent`).
6. Poll `getDevpods` for the tip’s pod → e.g. `STATE_RUNNING`; then scratch
   (`listScratchFiles` / `getFileContents`) for tools.
7. Assistant answer = new **AGENT** row `message` / `content.text` — not the
   user row’s `responseContent`, and not stale `getTask.latestUpdate` while
   the steer row is still PENDING.
8. Do **not** soft-stop on tip `CANCELLED`/`COMPLETED` alone during step 4–7.

## Done when

- [x] Orchestrator transport is Minion HTTP (not aifx) for getTask /
      createInteraction / listInteractions / getDevpods / createTask / cancelTask.
- [x] Steer tracks PENDING → RESPONDED; no stale latestUpdate Done after steer.
- [x] E2E A/B/D still green via `test:e2e:affected -- --base main`.
