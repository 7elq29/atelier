# Bug: NL daily-note create/edit caret invisible

## Repro
1. Open Daily Notes → Today agenda.
2. Right-click empty agenda → NL create card focuses.
3. Type — text appears (backdrop) but **no blinking caret**.

Root cause: `.dn-nl-textarea` uses `color: transparent` over a mirrored backdrop. Blink often ignores `caret-color` when `color` is the keyword `transparent`, so the caret disappears.

## Fix
- Use an opaque `caret-color: var(--text-primary)`.
- Prefer `color: rgba(0, 0, 0, 0)` over `transparent` so caret-color sticks.

## Done when
- [x] E2E asserts create-input textarea `caretColor` is not transparent (`agenda-nl-task-create`).
- [x] Screenshot `e2e-artifacts/agenda-nl-create-typed.png` — focused NL field with opaque caret color.
