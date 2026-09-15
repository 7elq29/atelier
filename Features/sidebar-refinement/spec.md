# Sidebar refinement

## Expected user flow

1. The user scans Notes and sees the primary destinations without redundant
   metadata: **Daily note** and **Weekly plan**.
2. The user opens a local terminal. Its row is immediately identifiable as a
   terminal by a stable terminal-window glyph, not an agent waiting spinner.
3. Agent rows continue to use live status icons; only terminal rows use the
   terminal identity icon.
4. Sidebar labels remain legible at the configured interface scale while
   reading more like Cursor's compact repository/chat list.
5. The user sees neutral grey `+` actions beside Sessions, Notes, and
   Bookmarks, so those utility controls do not compete with selected or
   working states that use the green accent.

## Expected UI

The existing mock is `Features/UI-Design/mocks/index.html`, sidebar Notes and
Terminals markup around `.sidebar-list-pane--terminals` and
`.sidebar-list-pane--notes`.

- Remove the `.row-tag` metadata under the fixed Daily note row
  ("Obsidian vault").
- Remove the `.row-tag` week range under the fixed Weekly plan row. The `+`
  create action remains when this week's plan is missing.
- Replace `SessionStatusIndicator` for `session.mode === 'terminal'` with a
  14px monoline terminal-window icon (rounded rectangle, `>_` prompt), using
  `.terminal-session-icon` and existing `--text-tertiary` color. Agent session
  status behavior is unchanged.
- Use the existing `--font-ui` system stack (the same family direction visible
  in Cursor) with sidebar-only optical tuning:
  - row names: `13.5px`, weight `450`, `-0.01em` tracking;
  - section labels: `10.5px`, weight `600`, `0.08em` tracking;
  - note destination names do not add a heavier `600` override.
- Do not change global interface, agent-message, or terminal font-size settings.
- Render `.sidebar-action-icon.primary` with existing `--text-tertiary`
  grey, matching the default sidebar action color. Preserve the existing
  `--text-secondary` hover color and transparent background.

The mock is updated to these exact treatments before production code.

## Reproduction evidence

- On clean `main`, the real one-click terminal flow produced
  `e2e-artifacts/sidebar-refinement-before.png`: the terminal backend row
  rendered the agent-only status glyph, and both note metadata tags remained.
- The failing assertion on `main` was:
  `terminal-session-icon` expected visible, element not found.
- The main-process log for the same run records a real `session.created`
  lifecycle event with `"mode":"terminal"`, proving the row was a terminal
  even though its visual identity was an agent status icon.
- After the fix, `e2e-artifacts/sidebar-refinement.png` shows the terminal
  glyph and single-line note rows.

## Done criteria

- Daily note has no "Obsidian vault" tag.
- Weekly plan has no date/range tag.
- A terminal row renders `.terminal-session-icon` and no
  `.session-status`; agent rows retain `.session-status`.
- Sidebar typography resolves to the sidebar-only sizes/weights above.
- The Weekly plan create button still appears when the file is missing.
- Sessions, Notes, and Bookmarks `+` icons resolve to `--text-tertiary`, not
  `--accent`, and retain their existing hover behavior.
- `npm run build` passes.
- `npm run test:e2e:affected -- --base main` passes, subject only to documented
  pre-existing failures.
- The focused E2E screenshot is personally viewed against the updated mock.
