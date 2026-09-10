# Bug: the terminal's last line is cut in half

In the session **Terminal** tab (and the terminal-only main view / companion
drawer) the bottom line of the pane is sliced horizontally — you see the top
half of the glyphs and nothing else. With a tmux-backed shell it's usually the
tmux status line that's half-visible, so the actual last line of output looks
cut instead.

## Root cause

`.term-body` — the element xterm is mounted into — carried `padding: 4px`, and
the app is globally `box-sizing: border-box`.

`FitAddon.proposeDimensions()` (`@xterm/addon-fit@0.10.0`) measures like this:

```js
const parentStyle = getComputedStyle(terminal.element.parentElement) // .term-body
const parentHeight = parseInt(parentStyle.getPropertyValue('height'))
const elStyle = getComputedStyle(terminal.element)                   // .xterm
const availableHeight = parentHeight - (paddingTop + paddingBottom)  // padding of .xterm
rows = Math.floor(availableHeight / cell.height)
```

It subtracts the padding declared on **`.xterm`**, but takes the height of the
**parent** — and under `border-box` the parent's computed `height` already
includes the parent's own padding. So `.term-body`'s 8px of vertical padding was
counted as usable space, buying one row more than actually fits. Measured on the
Terminal tab (cell height 16px, pane 704px):

| | before fix | after fix |
|---|---|---|
| rows | 44 | 43 |
| `.xterm` bottom | 804 | 792 |
| `.term-body` content bottom | 796 | 800 |
| overflow | **+8px (half a row)** | −8px |

`.term-body` has `overflow: hidden`, so that extra 8px is simply cut — the
horizontal slice the user sees. The same arithmetic applied to width, so the
right-most column was clipped too.

## Fix

Move the inset from `.term-body` to the `.xterm` element, which is the one
FitAddon actually accounts for. The pane keeps its 4px inset and the row count
becomes the number of rows that genuinely fit.

## Reproduction (must fail before the fix)

`e2e/terminal-pty.spec.ts` — "terminal: the pane fits whole rows, never clipping
the last line": opens a real terminal, then at several window heights asserts
that the `.xterm` box stays inside `.term-body`'s content box, vertically and
horizontally. Before the fix it overflows by 8px at any height where
`paneHeight % cellHeight < 8`, including the default window size.

## Done criteria

- The reproduction spec fails on `main`, passes after the fix.
- Screenshot `e2e-artifacts/terminal-pane-fit-bottom.png` viewed: the bottom
  line (tmux status line) is drawn whole, not sliced.
- `npm run build` clean; targeted category 10 e2e run.
