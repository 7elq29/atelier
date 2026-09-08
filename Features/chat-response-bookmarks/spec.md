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
6. Clicking any bookmarked file keeps **Chat** visible and opens the file in the right-hand
   review panel. A bookmarked changed-file row opens the existing diff review (current content
   against its baseline); a standalone bookmarked file opens the same review panel with its
   current contents and no synthetic baseline. It must not activate the **Files** tab. The
   bookmark itself remains until explicitly removed.

## UI

The interactive mock does not contain a standalone bookmarked-file preview state. Reuse these exact mock
treatments from `Features/UI-Design/mocks/index.html`:

- Cap and rows: `.chat-changes-card`, `.chat-changes-head`, `.chat-changes-body`,
  `.chat-changes-file`, and `.fname`.
- Bookmark tag: `.chat-changes-plan-tag` typography, spacing, radius, and info color tokens,
  exposed in production as `.chat-changes-bookmark-tag` with text **Bookmark**.
- Context menu: the established `.session-menu-popup` / `.smi` popup grammar and its
  `var(--bg-panel-raised)`, border, shadow, and hover tokens.
- File destination: the existing production right-hand `ResponseReviewPanel` treatment used by
  changed bookmarked files (`.response-review-panel`, file title/path chrome, rendered content).
  No new visual treatment is introduced.

Bookmarks live in their **own expandable section above the Changes section** (see
`Features/chat-uncommitted-changes/spec.md`), each header counting only its own rows — e.g.
**2 bookmarks** above **1 change**. A changed file that is also bookmarked stays in Changes
with its **Bookmark** tag and is therefore not counted in the Bookmarks header; if every
bookmark is also a changed file, the Bookmarks section is not rendered. Bookmark rows are
newest-first. URL rows use their visible chat link text when available, falling
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
  IPC effect, changed-file review-pane opening, standalone file right-hand review-pane opening
  without switching to **Files**, session isolation, and persistence after relaunch.
- The e2e captures the open context menu and expanded mixed cap to
  `e2e-artifacts/chat-response-bookmarks-*.png`, plus the standalone file open in
  `e2e-artifacts/bug-bookmark-file-right-panel.png`; all images are personally compared with
  `Features/UI-Design/mocks/index.html` and the existing production review pane.
- `npm run build` is clean.
- Run every mapped spec from the touched chat and secondary-panel categories in
  `e2e/TEST_CATEGORIES.md`, not only the new assertions.
