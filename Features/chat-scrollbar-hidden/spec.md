# Hidden chat scrollbar

## Expected user flow

1. Open a chat whose transcript is taller than the available window.
2. Scroll the transcript with a mouse wheel, trackpad, keyboard, or
   programmatic auto-follow.
3. The transcript continues to scroll normally, but no scrollbar track or
   thumb is visible at the right edge of the chat.
4. When response review is open, the chat column also scrolls without visible
   scrollbar chrome; the review panel keeps its own scrollbar.

## Expected UI

The supplied screenshot is the exact case being changed: remove the visible
vertical scrollbar at the right edge of the chat. The current
`Features/UI-Design/mocks/index.html` does not specify scrollbar visibility,
so no mock selector or token applies. Keep `.chat-body-row` as the existing
scroll owner and hide only its scrollbar chrome.

## Done criteria

- [ ] An overflowing `.chat-body-row` still has `overflow-y: auto` and remains
      scrollable.
- [ ] `.chat-body-row` has no visible WebKit or Firefox scrollbar.
- [ ] The response-review chat column follows the same behavior without
      changing `.response-review-body`.
- [ ] Transcript auto-follow behavior still passes its real E2E test.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass,
      except independently confirmed pre-existing failures.
