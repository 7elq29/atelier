# Background tasks — tracker rail only

## Problem

When the SDK reports background jobs, the same work appears twice: as **Background jobs** (and related family cards) in the tracker rail, and again as a **Background tasks** card at the bottom of the chat transcript.

The approved mock (`Features/UI-Design/mocks/sdk-harness-events-review.html`, `#bg-changed`) already specifies one `.tracker-card` per family in the rail. The transcript card is the duplicate.

## Expected user flow

1. User has a session with at least one SDK background task (monitor, job/workflow, shell, and/or subagent).
2. The tracker rail on the right shows the matching family cards (`background-jobs-card`, `background-monitors-card`, `background-shell-card`, `subagent-tracker-card`).
3. The chat transcript (`[data-testid="transcript"]`) does **not** contain a “Background tasks” card.

## Expected UI

- Reuse existing rail cards from the mock (`.tracker-card`, `.tracker-head`, `.background-rail-entry`).
- No `.background-tasks-conversation-card` in the transcript. There is no second mock treatment for that card; it is removed.

## Done criteria

- `npm run build` clean.
- `npm run test:e2e:affected -- --base main` includes `e2e/harness-sdk-events.spec.ts` coverage that:
  - injects mixed background tasks
  - asserts rail cards are visible
  - asserts `background-tasks-conversation-card` count is 0
- Screenshot `e2e-artifacts/08-subagent-vs-background-jobs-rail.png` viewed against the rail mock (no transcript duplicate).
