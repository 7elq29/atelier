# Agenda NL task create / edit

## User flow

### Create
1. Right-click agenda (or command-palette create) → floating NL card.
2. Type a sentence, e.g. `Logging Team Sync #meeting at 9:00 am for 1 h`.
3. As you type, `#tag` / start / duration get quiet colored underlines.
4. Typing `#` (or a partial tag) shows the same predefined tag autocomplete as other task fields; Tab applies the first suggestion; click applies a pick.
5. Click an underline → compact popover (time steppers/chips, or duration list). Popover edits rewrite the phrase in the sentence. Tag underlines do not open a popover.
6. Enter → create scheduled task (`timeBlock` + title/`#tags` via existing `addTask` parse). Esc / click-outside dismisses without create if empty.

### Edit existing
1. Double-click title → row expands to same NL sentence (reconstructed from text, tags, timeBlock).
2. Click row clock → time popover only (fast nudge); click-outside / Enter saves.
3. Click row duration → duration popover; saves the same way.
4. Drag-to-reschedule unchanged.

## UI
- Quiet underline mock: `Features/UI-Design/mocks/task-create-nl-redesign.html` + `task-nl-popover-edit.html`
- No circular duration dial on create/time-edit; drop-confirm card may keep dial until a follow-up.
- Empty-state copy “No scheduled tasks yet.” stays on the agenda list, not inside the create card.

## Done criteria
- [x] `npm run build` clean
- [x] Feature e2e green: `agenda-nl-task-create` + `bug-agenda-duration-save` (5/5)
- [x] New/updated e2e: create via NL sentence with time+duration+tag; edit duration via popover + click-outside saves
- [x] Screenshots in `e2e-artifacts/` viewed against mocks (`nl-walk-*.png`, `agenda-nl-*.png`)
- [ ] Full `npm run test:e2e:affected -- --base main` (handlers touch pulls obsidian suite — re-verify on CI / before merge)
