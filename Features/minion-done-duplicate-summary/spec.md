# Minion `Done.` duplicates the streamed answer

## Bug (MCP Tool Evaluation, 2026-10-28)

Session `e66e7153-…` posted the real answer via worker fold (`text_delta` →
assistant row), then ~28s later soft-stop posted a second row:

```
Done.

<prior progress…><same answer again>
```

`formatTaskSummary` fills empty `output.message` from `latest_update`, which
already held progress + answer. Soft-stop always pushed that summary on first
turn when `!sawNewAgentInteraction && lastSteeredAt <= 0`, ignoring that the
fold already owned the transcript (`foldHealthy`).

## Fix

When the worker fold is healthy (or the summary body is already in
`postedTexts`), finish the turn with a silent `result` / `end_turn` — never
re-post `Done.` + `latest_update`.

## Done

- [x] Idle completion with foldHealthy does not append a second answer blob
      (`shouldPostIdleTaskSummary` / `pushIdleTurnComplete`)
- [x] No-fold / cold path still posts `formatTaskSummary` when nothing was shown
- [ ] `npm run build` + affected e2e (minion-session when harness changes)
- [x] Case A asserts a single `A1-READY` assistant row before follow-up
