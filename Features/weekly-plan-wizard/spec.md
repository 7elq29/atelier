# Weekly plan wizard (guided review & plan)

## User flow

1. Under sidebar **Notes**, a **Weekly plan** row shows the current ISO week tag (e.g. `2026-W32`).
2. When `02.weeklynotes/YYYY-Wnn.md` is **missing**, a **`+`** on that row opens the **Weekly review & plan** wizard in the main panel (no auto-open on launch).
3. When the weekly file **exists**, clicking the row does **not** open the wizard yet — a short in-app hint says viewing/editing in-app is a later step.
4. Wizard steps (mock `#panel-weekly-plan`, `.wp-*` in `Features/UI-Design/mocks/index.html`):
   - Intro → AAR wins → last Big Three + reflection → rejuvenation → ideas (carry-overs) → weekly Big Three → schedule (pool + week matrix).
5. **Continue** / **Back** navigate steps; final step **Create weekly note** writes the vault file from template `92.templates/Weekly Notes Template.md` (built-in skeleton if missing), then hides **`+`** and closes the wizard.
6. Selecting a chat session or Daily note / app note closes the wizard and clears its active sidebar state.

## UI (mock reference)

`Features/UI-Design/mocks/index.html`: `#panel-weekly-plan`, `data-testid="weekly-plan-row"`, `weekly-plan-create-button`, progress dots, split layout with `.wp-context-panel`, schedule `.wp-cal-matrix`.

## Vault mapping

- Path: `02.weeklynotes/{ISO-WEEK}.md` (e.g. `2026-W32.md`).
- Sections filled on finish: AFTER ACTION REVIEW (wins), last-week Big Three scores, reflection, REJUVENATION, Ideas, Weekly Big Three, timed blocks + Q2 Blocks for scheduled `#q2` items.
- Context prefilled from previous weekly file (last Big Three) and previous ISO week daily notes (carry/open/completed hints).

## Done criteria

- [ ] `npm run build` clean.
- [ ] Targeted e2e: `e2e/weekly-plan-wizard.spec.ts` — missing file shows `+`, opens wizard, completes minimal flow, asserts file on disk.
- [ ] Category entry in `e2e/TEST_CATEGORIES.md` for weekly plan source paths.
- [ ] Sidebar + main panel mutual exclusion with sessions, daily note, app notes (same pattern as `Features/daily-note-notes-editor/spec.md`).
