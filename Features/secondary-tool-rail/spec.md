# Secondary tool rail and right panel

## User flow

1. A Claude Code session opens on Chat with Diff, Files, Terminal, and (for a
   remote session) Ports shown as plain vertical icons on the right edge of the
   session workspace, immediately left of the Daily Notes panel.
2. The icons have no enclosing rail background, border, label, or selected
   background. They are vertically grouped slightly above center; hover and
   active state change only the icon color. Active icons and count badges use
   neutral gray, never the green accent.
3. Clicking an icon opens that tool as the right half of a side-by-side split
   with Chat. Clicking another icon replaces the right tool rather than opening
   another pane.
4. The tool pane has no title/header bar. Overlay controls in its top-right
   corner close the pane or enlarge it to the full session workspace. The
   enlarge control becomes restore while enlarged. The icon group remains
   available in both states.
5. Closing the tool returns to Chat-only. The Chat composer remains owned by
   the Chat pane throughout.
6. Opening Diff on the right hides its file tree by default and shows every
   changed file as a vertically stacked diff. A Files toggle at the left of the
   Changes/Commits/Worktrees controls reveals or hides the file tree; selecting
   a tree file scrolls to that file's stacked diff.
7. Opening Files, either on the right or enlarged, shows the configured default
   workspace directory in the main content area and never shows the old left
   file tree.
8. The Files location bar is one control, not a duplicated input and
   breadcrumb. In its resting state every directory segment is a clickable
   link. Clicking the bar's empty area enables direct path editing; Enter opens
   the typed directory or file and Escape cancels.
9. Clicking a directory row opens it in the main Files content area. Clicking
   any directory segment in the location bar opens that ancestor.

## UI

The approved design is in `Features/UI-Design/mocks/index.html`:

- Reuse `.workspace-tool-rail` only as a transparent, borderless positioning
  container and `.workspace-tool-button` as a 36px hit target around a 22px
  icon. Do not add rail chrome or a "Tools" label.
- Reuse `.workspace-pane-head` as an absolutely positioned control group only;
  omit `.workspace-pane-title` and all header background/border treatment.
- Reuse `.workspace-pane-enlarge` and `.workspace-pane-close` for the overlay
  controls.
- Reuse `.diff-files-toggle`, `.diff-vertical-list`, and
  `.file-tree-expanded` for the narrow Diff behavior.
- Reuse `.files-path-bar`, `.files-path-field`, `.files-path-crumbs`,
  `.files-path-input`, `.files-path-segment`, `.files-directory-view`, and
  `.files-directory-row` for the Files browser.
- Existing app tokens (`--bg-input`, `--bg-hover`, `--text-tertiary`,
  `--text-primary`, and `--info`) provide the visual treatment. Tool icons do
  not use `--accent`.

The mock does not define a small-window fallback. Keep the icon group visible
and allow the existing split geometry/minimum-size behavior to govern narrow
windows.

## Done

- [ ] E2E confirms the horizontal tab strip no longer contains secondary tools.
- [ ] E2E confirms each available icon opens its corresponding right pane and
      selecting another icon replaces it.
- [ ] E2E confirms the active tool icon and count badge resolve to neutral gray
      rather than the green accent.
- [ ] E2E confirms enlarge, restore, and close without a tool title bar.
- [ ] E2E confirms Chat's composer remains inside Chat while a tool is open.
- [ ] E2E confirms Diff starts with no file tree, renders all changed files,
      and its Files toggle reveals the tree.
- [ ] E2E confirms clicking a file in the Diff tree scrolls the stacked list to
      that file.
- [ ] E2E confirms Files starts at the session workspace path with no left tree.
- [ ] E2E confirms a directory row and a clickable location segment navigate.
- [ ] E2E confirms typing a path and pressing Enter navigates.
- [ ] Screenshots cover the icon-only rail, right Diff, right Files, and
      enlarged Files states and are visually compared with the approved mock.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
