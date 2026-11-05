# Palette "New Task" without time → unscheduled

## Bug
Command palette → New Task opens the NL create card seeded with a default
clock (`startMin: now`). Committing a sentence with no time/duration falls
back to that clock, so the task lands on the agenda timeline.

## Expected
1. ⌘K → "New Task" → NL card.
2. Type a title only (no clock / duration).
3. Enter → task appears under **Unscheduled**, not Today/timeline.

Right-click create on the agenda still schedules at the clicked slot when no
time is typed.

## Done
- [x] Palette open sets `noTime: true` on the create draft
- [x] E2E: New Task without time → `unscheduled-task`, not `agenda-task`
- [x] Screenshot viewed (`e2e-artifacts/bug-palette-new-task-unscheduled.png`)
- [x] `npm run build` + `test:e2e:affected -- --base main`
