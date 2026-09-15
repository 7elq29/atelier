# Right review pane: wrap long file lines

## Bug

The right-hand file review pane configures its Monaco editor with
`wordWrap: 'off'`. A source line wider than the pane therefore continues past
the visible right border and requires horizontal scrolling.

## Expected user flow

1. The user opens a file bookmark or changed file in Chat's right review pane.
2. Any line wider than the pane wraps onto the next visual line.
3. Resizing the pane reflows the line to the new width; the user does not need
   to scroll horizontally to read it.

## Expected UI

Keep the existing full-bleed file review surface from
`Features/UI-Design/mocks/index.html`:
`.response-review-pane`, `.response-review-body--monaco`, and
`.response-review-content-grid--monaco`. The mock does not specify Monaco's
line-wrapping option, so the treatment is defined here: preserve the existing
monospace text, line numbers, and editor chrome, but enable bounded word wrap
inside the pane. No new controls or visual tokens.

## Reproduction

`e2e/ui-review-pane-chrome.spec.ts` opens a real bookmarked text file with one
line wider than the review pane, confirms `main.log` records the file opening,
and captures `e2e-artifacts/bug-review-pane-long-line-overflow.png`.

Before the fix, Monaco renders the long line as one visual line and exposes
horizontal scroll width. After the fix, that source line occupies multiple
view lines and the editor has no horizontal overflow.

## Done criteria

- [ ] The long line wraps within the right review pane.
- [ ] The reproduction assertion and log check pass.
- [ ] The screenshot is viewed and compared with the mock.
- [ ] `npm run build` is clean.
- [ ] `npm run test:e2e:affected -- --base main` passes.
