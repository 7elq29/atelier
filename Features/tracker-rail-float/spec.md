# Float the todos and background-jobs rail

## Expected user flow

1. Start a session that has todos or background jobs.
2. The Collapse control and the Todos / Background jobs / Subagents cards
   still appear, with the same card chrome.
3. They no longer reserve a vertical column. The transcript and composer use
   the full chat-column width; the rail floats over the right edge of the chat
   tab and stays put while the transcript scrolls.

## Expected UI

`Features/UI-Design/mocks/index.html` still treats `.tracker-rail` as a
in-flow flex sibling. Update that mock to the same overlay: reuse
`.tracker-rail`, `.tracker-rail-toggle`, and `.tracker-card` with no extra
panel background. Render the rail as a sibling of `.chat-body-row` (not
inside the scrolling row) and position it absolutely against
`.chat-tab-wrap` (`right: 8px`, `top: 16px`) so it is not a 244px flex
column. The overlay is only as tall as the cards, so the rest of the
transcript stays clickable.

## Validation / done criteria

- A real Electron E2E test with a live todo rail asserts
  `.tracker-rail` is `position: absolute` and `.chat-main-col` is the same
  width as `.chat-body-row`.
- Collapse still shrinks the overlay to ~40px and expand restores the cards.
- Screenshot `e2e-artifacts/tracker-rail-floating.png` is personally compared
  with the reserved-column screenshot.
- `npm run build` and `npm run test:e2e:affected` pass.
