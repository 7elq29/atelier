# Chat scroll-to-end affordance

## User flow

1. The user scrolls upward in the Chat transcript.
2. When the end of the session is more than one visible transcript page below
   the viewport, a down-arrow button appears above the composer, centered
   within the Chat pane.
3. Clicking the button scrolls the active Chat pane to the end.
4. The button disappears once the end is within one visible page, and remains
   hidden while the transcript is already near the end.
5. The same behavior applies when the dedicated review renderer is open and
   Chat occupies the left half of the workspace.

## UI

`Features/UI-Design/mocks/index.html` does not include a scroll-to-end control.
Use a compact circular icon button with the existing neutral
`--bg-panel-raised`, `--border-default`, `--text-secondary`, and
`--shadow-panel` tokens. Do not use the green accent. Position it as an overlay
at the bottom center of the Chat pane so it does not change transcript layout.

## Done

- [ ] The button is absent when the session end is within one viewport height.
- [ ] The button appears only when the distance to the end exceeds the active
      Chat scroller's `clientHeight`.
- [ ] Clicking it reaches the end and hides the button.
- [ ] The threshold and click behavior work for both the full-width Chat
      scroller and the left-side Chat scroller used with review.
- [ ] A real Electron E2E test exercises the user flow and captures the visible
      affordance.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
