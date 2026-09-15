# Todo tracker reliability

## Bug

The real `todo rail renders and updates live from TodoWrite` E2E intermittently
times out without rendering `todo-tracker-card`. The same failure cascades
through resize and scroll audits that use a TodoWrite-generated tracker as
their session fixture.

## Reproduction

1. Start a real Claude Code session.
2. Ask the agent to create two tracked items, then update their statuses.
3. Observe the persisted harness events, `main.log`, and the Chat screenshot.
4. The failing run states that `TodoWrite` is unavailable and therefore has no
   `todo_update` message for `TrackerRail` to render.
5. After using the available task tools, a second test defect appears: the
   final `1/2` state intentionally hides the completed row behind the
   `1 completed` disclosure, so polling visible `.todo-item.done` always
   times out.

## Expected behavior and UI

E2E fixtures must request the task tools currently exposed by Claude:
`TaskCreate` followed by `TaskUpdate`. The existing harness normalization then
produces complete `todo_update` snapshots. Assertions must respect the existing
completed-item disclosure. `TrackerRail` renders the mock treatment unchanged:

- `.tracker-rail` contains `.tracker-card`.
- `.todo-item.active` represents the in-progress item.
- `.todo-item.done` uses the existing accent box and strikethrough.
- Two successive task snapshots update the card live without requiring the
  assistant turn to finish.

The mock covers this UI at `Features/UI-Design/mocks/index.html` selectors
`.tracker-rail`, `.tracker-card`, `.todo-item.active`, and `.todo-item.done`;
no visual redesign is needed.

## Done

- [x] A captured failing real run proves that no usable todo snapshot reaches
      the persisted session messages.
- [x] The root causes are fixed in the test prompts and assertions rather than
      hidden by extending the Playwright timeout.
- [x] The exact task-tracker E2E passes repeatedly and captures
      `03-todo-rail.png`.
- [x] Resize/scroll task-tool fixtures no longer fail waiting for the tracker.
- [ ] `npm run build` and `npm run test:e2e:affected` pass (`npm run build`
      passes; the affected run's tracker tests pass, but unrelated pre-existing
      audit/subagent/files-panel failures keep the aggregate command red).
