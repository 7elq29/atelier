# Timeline drag-and-drop: 15-minute snap + label alignment

## User flow

1. Open the daily-notes panel (Today / Schedule).
2. Drag an unscheduled task onto the agenda overlay, or open Schedule and
   drag/right-click on the hour grid.
3. The ghost / draft start time snaps in **15-minute** increments (not whole
   hours / half-hours), and the left time label sits on the same Y as its
   horizontal grid line.
4. Dropping commits that snapped start (agenda still shows the duration card;
   schedule writes the time block directly). Moving an already-scheduled
   schedule block preserves the grab offset so the block does not jump.

## Expected UI

- **Agenda drag overlay** (`.dn-agenda-overlay-label` / slot `border-top`):
  label optical center shares the gridline Y (same treatment as schedule
  `.dn-hour-label` + `.dn-hour-line`). Mock reference:
  `Features/UI-Design/mocks/index.html` `.dn-hour-row` / `.dn-hour-label` —
  app diverges from the mock’s fixed `translateY(-6px)` in favor of
  `translateY(-50%)` so any font size stays centered on the line.
- **Schedule grid** (`.dn-hour-label` / `.dn-hour-line`): same centering.
- Snap interval is `SNAP_MINUTES` (15) everywhere a pointer Y maps to a start
  time (agenda drop/ghost/create, schedule drop/dragover/right-click create).

## Done criteria

- [ ] Agenda drop/ghost uses 15-minute start times (not `hour * 60` only).
- [ ] Schedule create/drop uses `snapMinutes` (not `snapToHalfHour`).
- [ ] Hour labels and gridlines share the same vertical center (±1px) in e2e.
- [ ] Schedule HTML5 reposition preserves grab offset + duration.
- [ ] `npm run build` clean; `npm run test:e2e:affected` passes for mapped
      targets; new/updated screenshots personally reviewed vs mock.
