# Cortana Terminal openReady on resume / reconnect

## Bug

Cortana Terminal only got `session:openReady` (and a mounted keep-alive tab
terminal) at **create** time. After app relaunch, startup reconnect, or manual
reconnect, Cortana never re-emitted openReady:

- `reconnect()` early-returned unless `mode === 'claude-code'`
- `refreshSessionWorkspace` / hydrateSnapshot also skipped Cortana
- `pendingPanelPreload` after harness events only ran `completeSessionOpen` for
  Claude

Result: Terminal tool rail showed an empty slot; no PTY spawn; typing did nothing.

### Follow-up: closed Cortana

Closed Cortana sessions (startup-idle History) still showed the Terminal tool
rail because the disconnected gate only applied to `claude-code`. Select
skipped hydrate/openReady while `closedAt` was set, so Terminal was a dead
empty slot. Closed Cortana now uses the same reconnect gate; Reconnect
re-emits openReady.

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

### Closed Cortana / manual reconnect
1. Closed Cortana shows the session-disconnected panel (no Terminal rail yet).
2. User clicks Reconnect.
3. Harness resumes **and** openReady fires so Terminal works again.

## UI

Reuse `SessionDisconnectedPanel` for closed/connecting Cortana (same as Claude).
No new chrome for the Terminal itself.

## Done / validation

- Selecting or reconnecting a Cortana session after relaunch yields a working
  Terminal that accepts input and echoes.
- Closed Cortana requires Reconnect before Terminal; after Reconnect, Terminal
  echoes.
- `patchFiles` never wipes `tabTerminalPtyId` / `workspacePath` on cache miss.
- `npm run build` clean; `npm run test:e2e:affected -- --base main` passes.
- New/changed screenshots in `e2e-artifacts/` viewed against the mock.
