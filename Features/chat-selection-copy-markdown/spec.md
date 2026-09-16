# Copy selected chat content as Markdown

## User flow

1. The user selects rendered content inside one completed Markdown chat
   message, such as a heading, bold text, a link, a list, or a fenced code
   block.
2. The user copies with the platform copy command or context-menu Copy.
3. The clipboard receives the corresponding slice of the message's original
   Markdown source, including syntax that is not visible in the rendered
   selection (`#`, `**`, link destinations, list markers, and code fences).
4. A partial selection inside ordinary text copies only that selected source
   text. Selecting a complete formatted node includes that node's Markdown
   delimiters.
5. Selections outside a rendered Markdown message, or spanning more than one
   message, keep the browser's existing plain-text copy behavior. The existing
   per-message Copy button continues to copy the entire raw message.

## UI

This feature has no visual treatment and is not represented in
`Features/UI-Design/mocks/index.html`. It changes only clipboard serialization
for an existing native text selection; selection appearance and message
actions remain unchanged.

## Done

- [ ] Selecting a complete mixed Markdown passage copies the exact original
      Markdown source rather than rendered plain text.
- [ ] Partial plain-text selection copies only the selected source characters.
- [ ] The existing full-message Copy action still copies the full raw source.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
