# Foldable Unscheduled and Trackers sections

## Expected user flow

1. Open Daily Notes.
2. Click the chevron or heading for **Unscheduled**.
3. Its task list and add-task control fold away, leaving a compact heading row.
4. Click the heading again to expand it with its tasks unchanged.
5. Repeat independently for **Trackers**.

Folding one section must not fold the other. Section folding is view-local and
resets when the Daily Notes panel is remounted.

## Expected UI

`Features/UI-Design/mocks/index.html` defines the existing
`#dnUnscheduledSection`, `#dnTrackersSection`, and `.dn-section-head`
treatment, but does not show collapsible headings. Reuse the existing live
`.dn-section-head-toggle` and `.dn-chevron` styles: a small right-pointing
chevron appears before a folded heading and rotates downward while expanded.
Folded sections show only their normal heading row and do not reserve a share
of the section content height.

## Validation / done criteria

- A real Electron E2E test loads seeded unscheduled and tracker tasks.
- Clicking each heading hides only that section's body and updates
  `aria-expanded`.
- Expanding restores the same tasks.
- A screenshot captures both sections in their folded state and is personally
  compared with the mock.
- `npm run build` and `npm run test:e2e:affected` pass.
