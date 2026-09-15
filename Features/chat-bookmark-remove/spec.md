# Remove a bookmark from the chat bookmark list

## User flow

1. The user expands the Bookmarks section above the chat composer.
2. They right-click a bookmarked link or file row.
3. A context menu opens with “Remove bookmark”.
4. They select it; the bookmark disappears immediately from the chat list and
   is removed from the session’s persisted bookmarks.

Opening a bookmark with click or keyboard continues to work as before.

## UI

`Features/UI-Design/mocks/index.html` defines `.chat-bookmark-row` for the
in-chat list, but does not define a removal action for that row. Reuse the
existing chat-link bookmark context menu from `ChatBookmarkContextMenu.tsx`,
including `.session-menu-popup`, `.chat-bookmark-menu`, `.smi`, and the
“Remove bookmark” label. No new visual token or inline control is introduced.

## Done criteria

- [ ] Right-clicking an in-chat bookmark row opens the existing bookmark
      context menu at the pointer.
- [ ] The menu says “Remove bookmark”.
- [ ] Selecting it removes the correct link or file bookmark from the UI and
      persisted session bookmarks without opening the bookmark.
- [ ] Normal click and Enter/Space still open bookmarks.
- [ ] A real Electron E2E covers removal and its screenshot is visually
      compared with the mock and existing context-menu treatment.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
