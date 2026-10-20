# App note rename — Space key

## Bug

Renaming a sidebar app note (`⋯ → Rename` or the rename input):

1. Pressing Space once inserts nothing.
2. Pressing Space twice inserts `. ` (period + space) — macOS double-space
   punctuation after the first Space was swallowed.

## Cause

`AppNoteRow` is `role="button"` and handles Space with `preventDefault` +
`onSelect`. While the rename `<input>` is focused, Space bubbles to the row
and is cancelled before the character is inserted.

## Expected

1. Open rename on an app note.
2. Type letters and single Spaces (e.g. `Hello world`).
3. The input shows those characters including normal spaces — not dropped
   Spaces and not forced `. ` from a single intentional Space.
4. Enter commits; Escape cancels.

## Done

- [x] Row Space/Enter activation is ignored while renaming (and rename
      input `stopPropagation` on keydown).
- [x] `e2e/obsidian-app-notes.spec.ts` covers Space in the rename input.
- [x] `npm run build` + `npm run test:e2e:affected -- --base main`
- [x] Screenshot `e2e-artifacts/app-note-rename-space-key.png` shows
      `Hello world` in the rename field.
