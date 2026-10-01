# Cortana Terminal openReady on resume / reconnect

## Bug

Cortana Terminal only gets `session:openReady` (and thus a mounted keep-alive
tab terminal) at **create** time. After app relaunch, startup reconnect, or
manual reconnect, Cortana never re-emits openReady:

- `reconnect()` early-returns unless `mode === 'claude-code'`
- `refreshSessionWorkspace` / hydrateSnapshot also skip Cortana
- `pendingPanelPreload` after harness events only runs `completeSessionOpen` for
  Claude

Result: Terminal tool rail shows an empty slot; no PTY spawn; typing does nothing.

## User flows

### Create Cortana (unchanged)
1. User creates a Cortana session.
2. App emits openReady with `$HOME` workspace + `tabTerminalPtyId`, spawns the
   local tab-terminal PTY, and mounts the keep-alive Terminal panel.

### Resume / select after relaunch
1. User relaunches Atelier and selects an existing open Cortana session
   (or startup reconnect brings the harness live).
2. App emits openReady (or hydrate returns the Cortana workspace payload) so the
   Terminal keep-alive mounts and can spawn/reattach.
3. Opening the Terminal tool shows a usable local shell at `$HOME`.

### Manual reconnect
1. User clicks Reconnect on a disconnected Cortana session.
2. Harness resumes **and** openReady fires so Terminal works again.

## UI

No new chrome. Reuse existing Terminal tab / reconnect overlay from
`Features/remote-tmux-lifecycle-and-terminal-recover`.

## Done / validation

- Selecting or reconnecting a Cortana session after relaunch yields a working
  Terminal that accepts input and echoes.
- `patchFiles` never wipes `tabTerminalPtyId` / `workspacePath` on cache miss.
- `npm run build` clean; `npm run test:e2e:affected -- --base main` passes.
- New/changed screenshots in `e2e-artifacts/` viewed against the mock.
