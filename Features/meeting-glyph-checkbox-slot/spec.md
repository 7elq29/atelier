# Meeting glyph in checkbox slot

## User flow
1. Agenda / timeline / unscheduled row with `#meeting` (plain bullet).
2. Checkbox column shows the two-person meeting glyph (not empty, not a toggle).
3. Title no longer shows a `#meeting` chip — tag still stored and present when editing.

## UI
- Glyph: `Features/UI-Design/mocks/meeting-glyph-proposal.html` (`#icon-meeting`)
- Slot: same 16×18 grid cell as `.dn-tbox`
- Color: `var(--text-tertiary)` / muted like duration

## Done
- [x] Agenda meeting row: `agenda-meeting-glyph` visible; no `#meeting` chip
- [x] `#meeting` still in note file / edit buffer (`formatTaskTextWithInlineTags`)
- [x] Screenshot viewed (`e2e-artifacts/meeting-glyph-checkbox-slot.png`)
- [x] `npm run build` + `test:e2e:affected -- --base main`

