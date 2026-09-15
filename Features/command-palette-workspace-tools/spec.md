# Command palette workspace tools

## User flow

1. While a connected Claude Code session is in the foreground, the user opens
   the command palette.
2. The palette offers **Open Diff**, **Open Files**, **Open Terminal**, and,
   for remote sessions, **Open Ports**.
3. Running a command opens that tool in the right half of the existing
   Chat/tool split, exactly as clicking its icon in the workspace tool rail.
4. Choosing another workspace command replaces the current right-hand tool.
5. Workspace-tool commands are omitted when there is no eligible Claude Code
   workspace in the foreground. **Open Ports** is omitted for local sessions.

## UI

Reuse the command-palette action rows in
`Features/UI-Design/mocks/index.html`: `cpData.actions` rendered as `.cp-item`.
The four entries use the existing `Workspace` category treatment; no new
palette chrome or visual token is introduced. The mock now includes the four
actions and routes each through its existing `selectTab(...)` interaction.

The resulting panel reuses the approved right-panel treatment from
`Features/secondary-tool-rail/spec.md`: `.workspace-tool-rail`,
`.session-workspace-tabs--split-row`, and
`.workspace-split-pane--secondary`.

## Done

- [ ] A local connected Claude Code session lists Diff, Files, and Terminal,
      but not Ports.
- [ ] Each listed command opens or replaces the right-hand tool pane.
- [ ] A remote connected Claude Code session also lists Open Ports.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
