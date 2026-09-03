# Chat response bookmarks

## User flow

1. In an assistant chat response, the user right-clicks either:
   - an external HTTP(S) Markdown link, or
   - a resolved file link, including a path rendered as linked inline code.
2. A context menu opens at the pointer with **Bookmark**. If that exact target is already
   bookmarked for the active session, the action reads **Remove bookmark**.
3. Choosing **Bookmark** persists the target for that session and immediately adds it to
   the changes cap above the composer. Bookmarks survive session switches and app relaunch.
4. A changed file that is also bookmarked appears once, retaining its `+`/`−` stats and
   gaining a **Bookmark** tag. An unchanged bookmarked file and a bookmarked URL appear as
   standalone rows. Duplicate bookmarks for the same normalized type + target are not created.
5. Clicking a bookmarked external link opens it through Electron's external-browser IPC path.
6. Clicking a bookmarked file that is also changed keeps the changed row's existing behavior:
   it opens the file review pane with its diff. Clicking a standalone bookmarked file activates
   **Files** and opens that absolute file exactly like a file link in the assistant response.
   The bookmark itself remains until explicitly removed.

## UI

The interactive mock does not contain a bookmark-specific state. Reuse these exact mock
treatments from `Features/UI-Design/mocks/index.html`:

- Cap and rows: `.chat-changes-card`, `.chat-changes-head`, `.chat-changes-body`,
  `.chat-changes-file`, and `.fname`.
- Bookmark tag: `.chat-changes-plan-tag` typography, spacing, radius, and info color tokens,
  exposed in production as `.chat-changes-bookmark-tag` with text **Bookmark**.
- Context menu: the established `.session-menu-popup` / `.smi` popup grammar and its
  `var(--bg-panel-raised)`, border, shadow, and hover tokens.

The cap header reports both kinds without calling bookmarks changes: for example,
**2 changes · 1 bookmark**. Bookmark rows are newest-first within their group and appear
after changed-file rows. URL rows use their visible chat link text when available, falling
back to the URL host, and expose the full URL as a tooltip. File rows show the basename and
expose the full path as a tooltip.

## Data

- Bookmarks are session-scoped SQLite records owned by the main process.
- A bookmark stores: stable id, session id, kind (`file` or `link`), normalized target,
  display label, and creation timestamp.
- Renderer access is through typed preload IPC methods/events; renderer-only storage is not
  the source of truth.
- Deleting a session cascades its bookmarks.

## Done criteria

- A real Electron e2e test obtains an assistant response containing an HTTP(S) link and a
  resolvable file path, then verifies right-click bookmark and remove-bookmark actions.
- The same test verifies the cap's bookmark tag, changed-file deduplication, URL external-open
  IPC effect, changed-file review-pane opening, standalone file Files-panel opening, session
  isolation, and persistence after relaunch.
- The e2e captures the open context menu and expanded mixed cap to
  `e2e-artifacts/chat-response-bookmarks-*.png`; both images are personally compared with
  `Features/UI-Design/mocks/index.html`.
- `npm run build` is clean.
- Run every mapped spec from the touched chat and secondary-panel categories in
  `e2e/TEST_CATEGORIES.md`, not only the new assertions.
