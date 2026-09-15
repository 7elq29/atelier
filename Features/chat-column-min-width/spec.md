# Raise the chat column preferred minimum by 50%

## Expected user flow

1. Open a chat session on a desktop-width window.
2. The transcript and composer share one centered column.
3. That column is 60% of the available chat surface on very wide panels.
4. When 60% would be narrower than **1080px**, the equal outer margins
   shrink first so the column stays 1080px (or the full available width if
   the surface is narrower than 1080px).

This is the same layout as `Features/UI-Design/mocks/index.html`
(`.chat-body-row` and `.composer-wrap`), with the preferred minimum raised
from 720px to 1080px (`720 * 1.5`).

## Validation / done criteria

- Live CSS and the mock both use `width: max(60%, min(1080px, 100%))`.
- `e2e/ui-chat-transcript-typography.spec.ts` asserts that formula for both
  the transcript row and the active composer.
- Screenshot `ui-chat-transcript-typography.png` is personally compared
  with the mock.
- `npm run build` and `npm run test:e2e:affected` pass.
