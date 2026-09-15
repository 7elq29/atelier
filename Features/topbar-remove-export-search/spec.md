# Remove download and search icons from the session topbar

## User flow

1. Open a Claude Code session.
2. The topbar shows workspace, tabs, and the cost chip.
3. There is no download (export) icon and no search (find) icon.
4. Find in conversation still opens with Ctrl+S; the inline search bar is
   unchanged. Export is no longer available from the topbar.

## UI

`Features/UI-Design/mocks/index.html` previously placed
`#icon-search` and `#icon-download` after `.topbar-chip`. Those two
`.btn.btn-icon.btn-sm` controls are removed. Keep `.search-bar-inline` for
keyboard find. Cost chip and tab strip stay as-is.

## Done criteria

- [ ] `[data-testid="export-menu-button"]` is absent.
- [ ] `[data-testid="toggle-transcript-search"]` is absent.
- [ ] Cost chip remains visible.
- [ ] Ctrl+S still toggles the inline transcript search bar.
- [ ] Screenshot of the topbar without the two icons compared with the
      updated mock.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
