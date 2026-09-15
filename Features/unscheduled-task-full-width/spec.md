# Unscheduled tasks use the full panel width

## Bug reproduction

1. Open Daily Notes with a real vault note containing a long unscheduled task.
2. Observe that the task text wraps or clamps while a large blank area remains
   between the text and the panel's right edge.
3. Confirm from `main.log` that the real daily note was loaded, and capture the
   broken panel state in
   `e2e-artifacts/bug-unscheduled-task-full-width-before.png`.

The user-provided screenshot also shows the failure: task labels use only the
left portion of the Unscheduled section even though the section continues to
the right-side scrollbar.

## Expected user flow and UI

1. Open Daily Notes.
2. Read the Unscheduled list.
3. Each task row spans the available width of `.dn-section-body`.
4. The task label uses all space after the checkbox, up to the section's right
   padding. Hover-only tag and remove actions appear at the right edge without
   permanently reserving label width.

The UI mock in `Features/UI-Design/mocks/index.html` covers the section and
task-row treatment with `#unscheduledList` and `.task-chip`. It does not cover
the live app's hover-only tag action. Keep that control hidden until hover and
position the hover actions at the row's right edge so they do not constrain
the resting task label.

## Validation / done criteria

- A real Electron E2E test loads a seeded daily note and verifies the
  Unscheduled row width matches its body content width.
- The test verifies a long task label uses the row's full text width when not
  hovered.
- The reproduction test fails before the fix and passes after it.
- `main.log` confirms the seeded daily note was read.
- The after screenshot is personally compared with the mock and the user's
  screenshot.
- `npm run build` and `npm run test:e2e:affected` pass.
