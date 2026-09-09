# Bug: scrolling inside a terminal walks shell history instead of scrolling

Scrolling the mouse wheel / trackpad over a terminal pane (session **Terminal**
tab, terminal-only session, or the companion drawer) replaces the command on
the prompt line — it cycles backwards and forwards through shell history —
instead of scrolling the terminal's output.

## Root cause

Every local terminal is `tmux attach-session` (`src/main/panels/pty.ts`), and a
tmux client lives in the **alternate screen buffer**. xterm.js has no scrollback
in the alt buffer, so its wheel handler translates each notch into cursor keys
(`@xterm/xterm@5.5.0`, `browser/Terminal.ts`):

```
if (!this.buffer.hasScrollback) {
  // Convert wheel events into up/down events when the buffer does not have scrollback, this
  // enables scrolling in apps hosted in the alt buffer such as vim or tmux.
  const sequence = C0.ESC + (... ? 'O' : '[') + (ev.deltaY < 0 ? 'A' : 'B');
```

Those `ESC [ A` / `ESC [ B` bytes reach zsh, whose readline binds Up/Down to
history search — hence "switching between commands". The comment assumes the
hosted alt-buffer app (tmux) will interpret the arrows as scrolling, but tmux
only does that when **mouse reporting is on**; with mouse off it forwards the
arrows straight to the shell.

The real scrollback lives in the tmux pane's history, which is only reachable
through tmux copy-mode, so the fix has to make tmux receive the wheel event.

## Fix

Turn on tmux's session-scoped `mouse` option for every Atelier-owned tmux
session, right after the session is guaranteed to exist and before the pty
attaches (local and remote/devpod paths both). tmux then advertises mouse
reporting, xterm forwards wheel events as mouse buttons instead of arrow keys,
and tmux's default `WheelUpPane` binding enters `copy-mode -e` and scrolls its
own scrollback (auto-exiting when scrolled back to the bottom).

Scoped per session (`set-option -t <session> mouse on`), never `-g`, so the
user's own tmux sessions and `~/.tmux.conf` are untouched.

Trade-off (standard tmux/iTerm behaviour): while mouse reporting is on, a plain
drag is handled by tmux; hold **Option** to force a local xterm selection
(`shouldForceSelection` on macOS).

Non-tmux terminals (tmux not installed, or the plain-`ssh` fallback) stay in the
normal buffer, where xterm's own scrollback already handles the wheel.

## Reproduction (must fail before the fix)

`e2e/terminal-pty.spec.ts` — "terminal: mouse wheel scrolls the pane's
scrollback instead of walking shell history":

1. Real terminal-only session on the repo root.
2. `echo <marker>`, then `seq 1 400` so the marker is pushed off-screen (the
   marker is not in the rendered viewport).
3. Real wheel events over the terminal body.
4. Assert the marker is visible again **and** the prompt line was not filled
   with a recalled history command.

Before the fix step 4 fails: the viewport never moves and the prompt line shows
the recalled `seq 1 400`.

## Done criteria

- The reproduction spec above fails on `main`, passes after the fix.
- `pty spawn: tmux mouse reporting enabled` in `main.log` for the spawned pty.
- Screenshot `e2e-artifacts/terminal-wheel-scrollback.png` viewed: scrolled-back
  output visible, prompt untouched.
- `npm run build` clean; targeted category 10 e2e run.
