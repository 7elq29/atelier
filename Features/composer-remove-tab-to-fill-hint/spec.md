# Remove the composer "Tab to fill" hint

## Bug reproduction

1. Start a real chat session and wait until the turn is idle.
2. When the SDK pushes a `prompt_suggestion`, the empty composer shows that
   suggestion as ghost placeholder text.
3. Below the input, next to the mode pill, a `Tab to fill` label appears.

The user-provided screenshot shows this on a live idle composer. `main.log`
records `harness event: prompt_suggestion` when the SDK sends the suggestion.

## Expected user flow and UI

1. Open a session whose composer is empty.
2. If a prompt suggestion is present, it still appears as the input
   placeholder and Tab still fills it.
3. The composer footer no longer shows "Tab to fill" or any equivalent hint.

`Features/UI-Design/mocks/index.html` does not include this hint. The SDK
review mock (`sdk-harness-events-review.html`) currently renders
`.composer-suggestion-hint`; that demo is updated to match the live footer
(mode pill only, no Tab hint).

## Validation / done criteria

- A real Electron E2E test waits for an idle composer after a real SDK turn
  and asserts the composer contains no "Tab to fill" copy and no
  `composer-suggestion-hint` node.
- If `main.log` contains `prompt_suggestion` for that session, the input may
  still show the suggestion placeholder, but the hint must stay absent.
- Screenshot of the idle composer is personally compared with
  `Features/UI-Design/mocks/index.html`.
- `npm run build` and `npm run test:e2e:affected` pass.
