# Keyboard hints (Vimium-style)

## User flow

1. User **holds ⌘** (Command) anywhere in the main app shell (`#app`), with no modal open.
2. Short **letter badges** appear on every visible button, link, and text input in that shell.
3. While **still holding ⌘**, user presses the badge letter(s) or **1–9** (session index in the sidebar list; **10+** uses two digits).
4. The matching control **focuses** (inputs) or **clicks** (buttons).
5. Releasing **⌘** without a complete match dismisses the overlay. **Escape** also dismisses. If **⌘** is released while another app has focus (e.g. **⌘Tab**), the overlay dismisses on blur/focus without needing the missed keyup.

Excluded from labeling (not from activation): modal overlays, terminal (xterm), Monaco editor — interactives inside `data-hint-exclude-root` are not hint targets, but hold ⌘ still works when focus is in the terminal or file editor.

## UI

- Reuse mock tokens: `--accent`, `--bg-panel`, `--text-primary`, `--r-sm`, `--font-mono` from `Features/UI-Design/mocks/shared.css` / `tokens.css`.
- Fixed-position badges (`keyboard-hint-badge`) at each target’s top-left, above content (`z-index` below modals).

## Done criteria

- Hold ⌘ shows overlay; matching key activates a known sidebar control (e2e).
- Modals open → hints inactive.
- `npm run build` clean; `global-nav-and-settings.spec.ts` + `app-shell.spec.ts` pass (styles + App wiring).
