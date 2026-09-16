# Keyboard hints (Vimium-style)

## Workspace tool rail regression

1. Open a Claude Code session so the floating Diff, Files, and Terminal tool
   buttons are visible.
2. Hold Command until hint mode appears.
3. Current failure: the tool buttons receive generic generated hint labels
   instead of their mapped `d`, `f`, and `t` shortcut labels because the
   floating rail does not expose `data-session-tab-shortcut`.
4. Expected: Diff shows `d`, Files shows `f`, Terminal shows `t`, and a
   remote session's Ports button shows `p`.

This is a renderer-only attribute/overlay issue and emits no main-process log
event. The existing `keyboard-hint-badge` visual treatment is reused.

## User flow

1. User **holds ⌘** (Command) anywhere in the main app shell (`#app`), with no modal open.
2. Short **letter badges** appear on every visible button, link, and text input in that shell, including Files-tab directory and file rows (`role="button"` on `.files-tree .ft-item`).
3. While **still holding ⌘**, user presses the badge letter(s) or **1–9** (numbered sidebar rows: sessions then notes; **10+** uses two digits).
4. The matching control **focuses** (inputs) or **clicks** (buttons).
5. In a Claude Code session, **⌘+d/f/t/p** directly toggle Diff/Files/Terminal/Ports; the same keys use that toggle behavior while hints are active. **⌘+h** returns to Chat while hints are active. **⌘+c/v/a/x** are never intercepted (copy/paste/select-all/cut). Those letters are excluded from the chrome hint badge pool so they never appear as single-key targets. Tab buttons show their shortcut letter badges during hint mode (tabs stay excluded from the general letter-hint pool).
6. Releasing **⌘** without a complete match dismisses the overlay. **Escape** also dismisses. If **⌘** is released while another app has focus (e.g. **⌘Tab**), the overlay dismisses on blur/focus without needing the missed keyup.

Excluded from labeling (not from activation): modal overlays, terminal (xterm), Monaco editor — interactives inside `data-hint-exclude-root` are not hint targets, but hold ⌘ still works when focus is in the terminal or file editor.

## UI

- Reuse mock tokens: `--accent`, `--bg-panel`, `--text-primary`, `--r-sm`, `--font-mono` from `Features/UI-Design/mocks/shared.css` / `tokens.css`.
- Fixed-position badges (`keyboard-hint-badge`) at each target’s top-left, above content (`z-index` below modals).

## Done criteria

- Hold ⌘ shows overlay; matching key activates a known sidebar control (e2e).
- Floating workspace tools show their fixed `d`/`f`/`t`/`p` labels instead
  of generated chrome labels.
- Modals open → hints inactive.
- `npm run build` clean; `global-nav-and-settings.spec.ts` + `app-shell.spec.ts` pass (styles + App wiring).
