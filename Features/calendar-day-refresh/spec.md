# Calendar-day refresh without relaunch

## User flow

1. Atelier remains open while the local calendar date changes, including while
   focused, backgrounded, asleep, or locked.
2. At local midnight, or immediately after resume/unlock, Atelier refreshes
   every live "today" surface without requiring a relaunch.
3. The Daily Notes sidebar switches to the new day's note. Its date header,
   timeline, carry suggestions, and move-to-date options all follow the new
   date.
4. If the full-page Daily note editor is open, it switches to the new day too.
   Previous/next navigation remains available afterward.
5. The Weekly plan row and any open weekly view/wizard refresh to the ISO week
   containing the new date.
6. A missing note is not created merely because midnight passed; existing
   create-on-demand behavior remains unchanged.

## UI

No new UI is introduced. Reuse the existing treatment from
`Features/UI-Design/mocks/index.html` and `shared.css`:

- `.daily-notes-panel`, `.daily-date`, `.dn-timeline-grid`, and
  `.timeline-now-line` for the refreshed Daily Notes sidebar and timeline.
- `#panel-daily-note`, `.daily-note-row`, and `.daily-date-nav` for the
  full-page Daily note editor.
- `#weeklyPlanSidebarRow`, `#weeklyPlanWeekTag`,
  `#panel-weekly-plan`, and `#panel-weekly-plan-view` for weekly status and
  content.

The mock does not define a rollover animation or notification, so the refresh
uses the existing loading/content states with no toast or new chrome.

## Behavior and efficiency

- The main process owns one calendar-day scheduler. It waits until the next
  local midnight and also reconciles on system resume and screen unlock.
- It emits only when the resolved `YYYY-MM-DD` value differs from the last
  published value. The renderer does not poll for calendar changes.
- A renderer focus check provides a cheap fallback for manual clock/timezone
  changes.
- `ATELIER_TEST_DATE` remains deterministic and disables wall-clock
  scheduling; e2e drives the same production change-notification path through
  a test-only debug IPC.

## Done criteria

- [ ] Staying open across midnight refreshes sidebar date/note, full-page
  editor, timeline note, and weekly-plan status/view/wizard.
- [ ] Resume and unlock reconcile a date change missed while sleeping.
- [ ] Closed panels remain closed and no daily or weekly note is silently
  created.
- [ ] Calendar-date work uses one main-process timeout plus event checks, with
  no renderer calendar interval.
- [ ] The rollover e2e proves the old date first, triggers a date change,
  verifies the new daily and weekly state, and captures a reviewed screenshot.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
