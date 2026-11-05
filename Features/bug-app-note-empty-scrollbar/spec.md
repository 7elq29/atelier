# App note: no scrollbar when content fits

## Bug

Opening an app note (e.g. Backlog) whose body fits in the viewport still shows
a vertical scrollbar on the CodeMirror scroller. Daily notes already hide that
chrome (`scrollbar-width: none`); app notes did not.

Root cause: `scrollPastEnd()` in `noteEditorLayoutExtensions` adds bottom
padding so the last line can scroll to the top, which always makes
`scrollHeight > clientHeight`. The visible track is the bug — wheel/keyboard
scrolling should keep working.

## Expected user flow

1. Open a short app note whose checklist/body fits on screen with empty space
   below.
2. No vertical scrollbar track or thumb is visible on the note editor.
3. Trackpad/wheel/keyboard can still scroll (including scroll-past-end).

## Expected UI

Same treatment as daily notes (`.daily-note-editor-panel .cm-scroller`): hide
native scrollbar chrome on `.app-notes-panel .cm-scroller`. The mock
(`Features/UI-Design/mocks/index.html` `#panel-app-notes`) does not specify
scrollbar visibility; match the daily-note editor pattern already in
`global.css`.

## Done criteria

- [ ] Short app note: `.app-notes-panel .cm-scroller` has `scrollbar-width: none`
      and WebKit scrollbar `display: none`.
- [ ] Scroller remains `overflow-y: auto|scroll` and programmatic scroll still
      moves `scrollTop`.
- [ ] Screenshot `e2e-artifacts/bug-app-note-empty-scrollbar.png` shows no
      scrollbar track.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
