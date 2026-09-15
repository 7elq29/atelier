# Workspace split chat composer ownership

## Problem

In a workspace split, the persistent chat composer is rendered below the
entire split container. The existing row and stacked split screenshots show
the input spanning beneath both Chat and its Diff/Files/Terminal sibling,
which makes it look shared by both panes.

## User flow

1. The user opens Chat and drags Diff, Files, or Terminal to create a split.
2. The chat transcript and its input remain one visual panel.
3. The sibling pane uses its full pane height and never appears to own or
   share the chat input.
4. Resizing the divider keeps the input attached to the Chat pane.
5. Left/right and top/bottom splits behave the same way.
6. Closing the split restores the existing centered responsive composer.
7. Switching away and back preserves the per-session draft and composer
   state, as it does today.

## UI

The mock already places `.composer-wrap` inside `.chat-tab-wrap`, after the
chat body. Reproduce that ownership visually while retaining the real app's
`.composer-cache` keep-alive behavior.

- In a single Chat view, `.composer-cache-entry.active` remains centered at
  60% on wide surfaces, with a 1080px preferred minimum.
- In a split, `.composer-cache` takes the same primary/secondary pane geometry
  as `.tab-content[data-tab='chat']`.
- The active composer remains centered within that Chat pane and uses the
  pane's full width when the pane is narrower than 1080px.
- The Chat pane reserves the composer's live rendered height so transcript
  content does not sit behind it.
- No colors, type, controls, split-divider, pane-close, or sibling-panel
  treatments change.

## Done

- [x] A real Electron E2E creates Chat + Diff row and stacked splits.
- [x] In each direction, the composer is horizontally contained by the Chat
      pane and its bottom edge aligns with the Chat pane's bottom edge.
- [x] In a stacked split, the composer does not overlap the lower sibling.
- [x] The Chat content area ends above the composer rather than scrolling
      behind it.
- [x] Closing the split restores the centered responsive single-pane composer.
- [x] Main-process logs contain `session:openReady` and `files:list:done`,
      corroborating the real session/workspace used by the geometry test.
- [x] Broken and corrected row/stacked screenshots are personally compared.
- [ ] `npm run build` and `npm run test:e2e:affected` pass (`npm run build`
      passes; the affected run is blocked by independently reproduced
      pre-existing audit/TodoWrite fixture failures).
