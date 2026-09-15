# Responsive composer actions

## User flow

1. With an empty or single-visual-line composer, the model/effort selector and
   Send icon sit inside the input row on its right edge. While a turn is busy,
   the Stop and queue/send icons occupy that same inline action group.
2. When explicit newlines or soft wrapping make the input multi-line, the
   complete action group moves to the right side of the composer footer so it
   never covers typed text.
3. Returning to one visual line moves the controls back into the input row.
4. Context-window usage is represented by a circular progress ring in the
   footer. Hover text and its accessible label retain exact used/maximum token
   counts and percentage; usage at or above 70% uses the warning color.

## UI

The supplied Cursor screenshot defines the responsive interaction, but the
existing Atelier mock does not cover it. Update
`Features/UI-Design/mocks/index.html` before implementation with:

- `.composer-primary-actions` and `.composer-primary-actions--inline` for the
  model selector plus Stop/Send controls.
- `.composer-box--multiline` for the footer placement state.
- `.context-usage-ring`, `.context-usage-track`, and
  `.context-usage-progress` for the 18px circular context indicator.

Reuse the existing `.footer-btn`, `.send-btn`, `.stop-btn`, `.composer-footer`,
`--bg-hover`, `--border-default`, `--text-tertiary`, and `--warning` tokens.
The input reserves enough right padding for inline controls and the rendered
Markdown mirror uses the same padding.

## Done criteria

- Empty, short, explicit-newline, soft-wrapped, and shortened-again input
  states place the action group correctly in a real Electron E2E.
- Model picker selection, Send, Stop, and queue/send behavior remain wired to
  their existing actions in either placement.
- The context indicator renders as a circular SVG ring with exact usage in its
  title/accessible label.
- Screenshots cover one-line and multi-line states and are visually compared
  with the updated mock and supplied Cursor reference.
- `npm run build` and `npm run test:e2e:affected -- --base main` pass, subject
  only to documented pre-existing failures.
