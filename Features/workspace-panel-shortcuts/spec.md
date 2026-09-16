# Workspace panel shortcuts

## Expected user flow

1. In an active Claude Code session, press:
   - ⌘D to toggle Diff.
   - ⌘F to toggle Files.
   - ⌘T to toggle Terminal.
   - ⌘P to toggle Ports when the session supports Ports.
2. If that tool is closed, the shortcut opens it on the right. If the same
   tool is already open, the shortcut closes it and returns focus to Chat.
   Pressing a different tool shortcut replaces the open right-hand tool.
3. Press ⌘→ to toggle the Timeline panel.
4. Press ⌘← to toggle the left sidebar.
5. Shortcuts do nothing while a modal overlay is open. ⌘P does nothing for
   local sessions where Ports is unavailable.

## Expected UI

No new visual treatment is needed. Reuse the existing
`.workspace-tool-button` active state, `.topbar-timeline-toggle` active
state, and `.sidebar.collapsed` state from
`Features/UI-Design/mocks/index.html`. Update shortcut behavior only.

## Done criteria

- [ ] Each workspace shortcut opens its panel, and pressing it again closes
      that panel.
- [ ] Switching shortcuts replaces the currently open workspace tool.
- [ ] ⌘P is ignored for local sessions and toggles Ports for remote sessions.
- [ ] ⌘→ toggles `[data-testid="daily-notes-panel"]`.
- [ ] ⌘← toggles the sidebar collapsed state.
- [ ] Existing hold-⌘ hint shortcuts use the same toggle behavior.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
