# Bookmarks (sidebar)

App-wide list of links in the left sidebar, independent of any session.
(Session-scoped chat bookmarks in the changes cap are a separate feature —
see `Features/chat-response-bookmarks/spec.md`.)

## User flow

1. Sidebar order: **Sessions**, **Terminals**, **Notes**, separator, **Bookmarks**.
2. **+** in the Bookmarks head opens the **Add bookmark** dialog: **URL** (required,
   monospace) and **Title** (optional). Enter saves, Esc/Cancel closes. A URL typed
   without a scheme is normalized to `https://`; a non-`http(s)` URL is rejected with
   an inline error.
3. Clicking a bookmark row opens the URL in the **external browser**
   (`shell:openExternal`) — never in-app.
4. A row shows its **title**; with no title it shows the **URL itself**, truncated
   with `…` by the existing `.session-name` ellipsis. The full URL is the row tooltip.
5. Row **⋯** menu: **Edit** (same dialog, prefilled — can change URL and/or title) and
   **Remove**.
6. **Drag a link out of an assistant chat message and drop it on the Bookmarks pane.**
   The pane shows a dashed accent drop outline while a link hovers it. The link text
   becomes the title (dropped only if it is the bare URL). Dropping a URL that is
   already bookmarked is a no-op — no duplicate row.
7. Bookmarks persist in SQLite across relaunch, newest last (`sort_order`).

## UI

- Reference mock: `Features/UI-Design/mocks/index.html` — `#sidebarBookmarksPane`
  (pane) and `#modal-sidebar-bookmark` (dialog).
- Pane reuses the Notes pane structure exactly: `.sidebar-list-pane`,
  `.sidebar-section-head`, `.sidebar-pane-label`, `.sidebar-action-icon primary`,
  `.session-list--natural`, `.session-row`, `.session-indicator` (chain-link glyph),
  `.session-main`/`.session-name`, `.row-menu-btn`, `.history-empty-hint`.
- Dialog reuses `.modal-backdrop`/`.modal-dialog`/`.modal-header`/`.modal-body`/
  `.modal-footer`/`.field-label`/`.input`, 560px wide, both inputs full width
  (a bare `.input` has no width, so it must be set explicitly — see the mock).
- New CSS only for: `.sidebar-list-pane--bookmarks` row indicator color, the
  `.drop-ready` drop outline, and full-width dialog inputs.

## Done

- `npm run build` clean.
- `e2e/session-organization.spec.ts` — bookmarks test: add with title, add bare URL
  (row label is the URL), edit, click-opens-external (assert `shell:openExternal` in
  the main log), drag a chat link into the pane, duplicate drop is a no-op, remove,
  persistence across relaunch (DB assert via `debugQueryDb`).
- Mapped categories per `e2e/TEST_CATEGORIES.md` (Sidebar.tsx + MarkdownMessage.tsx):
  `session-organization.spec.ts`, `weekly-plan-wizard.spec.ts`,
  `global-nav-and-settings.spec.ts`, `bug-keyboard-hint-labels.spec.ts`,
  `chat-surface-core.spec.ts`, `interactive-prompts.spec.ts`.
- Screenshots in `e2e-artifacts/`: pane with both row kinds, the add dialog, the
  drop-ready state — each viewed and compared against the mock.
