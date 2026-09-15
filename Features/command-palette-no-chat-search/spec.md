# Remove chat-message search from the command palette

## User flow

1. Open the command palette (⌘K / Ctrl+K).
2. Type a command name, an action, or a **session title**. Matching rows
   still appear (Actions, Sessions by name).
3. Type a phrase that only exists inside a chat transcript (message body).
   The palette does **not** show snippet rows such as
   `…message text — in <session>` with category Session.
4. Find in the current conversation is unchanged (Ctrl+S / inline search
   bar). Session switching from a name match is unchanged.

## UI

`Features/UI-Design/mocks/index.html` `#modal-command-palette` filters
`cpData` titles only (`renderPalette` / `i.t.includes(q)`). There is no
message-snippet result type. Production currently appends FTS hits via
`searchContent` / `window.atelier.searchMessages`; that extra source is
removed. Same `.cp-item` / `.cpsub` rows for remaining items.

## Done criteria

- [ ] Command palette items come only from `paletteItems` (actions +
      session **names**), never from message-content FTS.
- [ ] Typing a unique transcript phrase that is not in a session name
      yields no Session snippet row (`— in`).
- [ ] Ctrl+S in-conversation search still works.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
