# Remote tmux lifecycle + dead-terminal recovery + remove companion drawer

## User flows

### Close / delete a remote session
1. User closes or deletes a session that has (or had) a Terminal tab / terminal-only
   shell on a remote host.
2. Atelier permanently kills that session’s named `atelier-*` tmux windows **on the
   remote host** (not only on the Mac).
3. Quit alone still only detaches; remote tmux for **still-open** sessions survives
   so relaunch can reattach.

### App crash / leftover orphans
1. On next launch, Atelier lists `atelier-*` tmux sessions locally and on every
   hostname still referenced by any DB session row.
2. It kills any whose name does not belong to a **currently open** Atelier session
   (History/closed and deleted leftovers are pruned). Pool / e2e names are skipped.

### Dead Terminal tab
1. If the SSH/tmux client process exits while the Terminal UI is still mounted,
   the panel shows a reconnecting state and does not silently swallow keystrokes.
2. It re-runs spawn: attach if the named tmux still exists; **create a new tmux
   session** if it is gone.
3. On failure, show “Terminal disconnected” with a Reconnect control.

### Companion drawer removed
1. The unused companion terminal drawer is gone (no component, no `:companion`
   pty/tmux cleanup paths, no companion header variant).

## UI

Mock does not cover reconnect chrome. Reuse existing tokens:
- Overlay on `.term-body` / `.term-shell` with tertiary text + existing `.btn`
  for Reconnect (no new color tokens).
- No companion drawer chrome.

## Done / validation

- Close/delete of a remote session removes its remote `atelier-…` tmux.
- Startup prune removes orphan remote `atelier-*` not tied to open sessions.
- Quit + reopen with session still open still reattaches (persistence regression).
- Forced shell exit / missing remote tmux recovers to a usable shell (create if needed).
- Companion drawer files/references gone; no `:companion` kill paths.
- `npm run build` clean; `npm run test:e2e:affected -- --base main` passes.
- New/changed screenshots in `e2e-artifacts/` viewed against the mock.
