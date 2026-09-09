# Remove the Terminal tab header bar

The session **Terminal** tab currently draws an extra chrome strip
(`.term-panel-header`: glyph, “Terminal” label, cwd chip, host chip) above
xterm. That strip is not in the mock and duplicates the session topbar’s
tab label.

## User flow

1. Open a Claude Code session and switch to the **Terminal** tab (click or
   existing ⌘ hint).
2. The pane is the shell: xterm fills the tab, with the command-toolbox
   button overlaid at the top-right of `.term-shell-main` — same placement
   as `Features/UI-Design/mocks/index.html` (`.term-shell-main > .term-toolbox-toggle`).
3. There is no “Terminal” title bar, cwd chip, or host chip in this tab.
4. The companion drawer (Chat + Terminal overlay) **keeps** its header,
   because the mock’s `.drawer-head` still needs a title and close control.

Terminal-only sessions use the same shell chrome as the Terminal tab, so
they lose the extra bar too.

## UI

Reuse the mock Terminal tab: `Features/UI-Design/mocks/index.html` lines
around the `data-tab="terminal"` block — `.term-shell` / `.term-shell-main` /
`.term-toolbox-toggle` overlay / `.term-body`. No new tokens. Companion
drawer still uses `.term-panel-header` (live analogue of `.drawer-head`).

## Done criteria

- Session Terminal tab and terminal-only main view: `terminal-panel-header`
  is not in the DOM; `terminal-toolbox-toggle` remains.
- Companion drawer still shows the header and close button.
- Project-path change still respawns the pty at the new cwd (asserted via
  a real `pwd` in the shell, not a header chip).
- Screenshot `e2e-artifacts/07-terminal-tab-no-header.png` viewed against
  the mock.
- `npm run build` clean; targeted category 10 run for the overlapping specs.
