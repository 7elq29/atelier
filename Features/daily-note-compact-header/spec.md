# Daily note compact header

## User flow

1. Open **Daily note** from the sidebar.
2. The title, date navigation, and sync state appear in one topbar row.
3. Use the left/right arrows around the date to move one day backward or
   forward. There is no separate **Today** button.
4. The sync state remains visible at the far right and updates between
   **Saving…**, **Updated from vault**, and **Synced**.

## UI

The current mock already establishes that Daily note metadata belongs in the
main `.topbar` (`Features/UI-Design/mocks/index.html`,
`#panel-daily-note .topbar`, `.daily-date-nav`, and `.daily-sync-chip`), while
the live app incorrectly renders it in a second
`.daily-note-editor-toolbar` row.

The requested compact treatment is not represented by the current mock, which
still has a text **Today** button and the older full-size bordered sync pill.
Update the mock and live UI together:

- Keep the `.title` at the left of the topbar.
- Place `.daily-date-nav` immediately after it as a compact group ordered
  previous arrow → date → next arrow.
- Use 11.5px secondary text for `.daily-date-label`, with no fixed minimum
  width.
- Remove the Today button rather than replacing it with another control.
- Render `.daily-sync-chip` at the right as a quiet 10.5px status with a 5px
  state-colored dot, no border, and no filled pill background.
- Reuse existing tokens: `--text-secondary`, `--text-tertiary`, `--accent`,
  `--warning`, `--bg-hover`, and `--r-sm`. No new tokens.

At narrow widths, the title stays legible and the date group remains on the
same row; the status may shrink to its dot while retaining its full text as an
accessible label and tooltip.

## Done criteria

- Daily note has one header row, not a topbar plus editor toolbar.
- Title, previous arrow, date, next arrow, and sync state share that row.
- No visible or DOM **Today** control remains.
- Previous/next navigation still changes the date and loads the corresponding
  real vault note.
- Sync status remains accessible and reflects the current state.
- Screenshot `e2e-artifacts/daily-note-compact-header.png` is viewed against
  the updated mock.
- `npm run build` passes.
- All category 11 specs mapped by `e2e/TEST_CATEGORIES.md` pass, or any
  unrelated pre-existing failure is confirmed by isolated reruns.
