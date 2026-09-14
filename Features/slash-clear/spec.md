# `/clear` clears the conversation

## User flow

1. User is in a Claude Code session with transcript messages visible.
2. They type `/clear` in the composer and select it from the slash popover
   (or press Enter on the `/clear` match).
3. The composer text is removed. The session row stays selected.
4. The transcript goes empty (existing empty chat state — no toast, no new
   chrome). The next send is a fresh conversation: the model does not have
   the previous turns.
5. If the machine is asleep or the harness is disconnected, Atelier still
   empties the local transcript so a later reconnect does not restore the
   old CLI conversation.

## UI

No new UI. Reuse `Features/UI-Design/mocks/index.html` composer slash
popover (`.slash-popup`) and the existing empty transcript (no
`transcript-message` rows). The mock does not define a dedicated `/clear`
animation.

## Behavior

- `/clear` is a real Claude Code command (`SDKConversationResetMessage`).
  Atelier must not swallow it as “clear the composer only.”
- On reset, delete persisted messages for this Atelier session, keep the
  sidebar session id, and remember the SDK `new_conversation_id` for later
  `--resume`.
- Later reconnect uses that SDK id as the CLI conversation, while harness
  maps stay keyed by the Atelier session id.

## Done criteria

- [ ] Slash popover still lists `/clear` first among local commands, with
  description “Clear conversation”.
- [ ] Selecting `/clear` empties composer and transcript without creating a
  new sidebar session.
- [ ] SQLite has no leftover messages for that session; main log records the
  reset.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
- [ ] Screenshot of the empty transcript after `/clear` compared to the
  mock’s empty chat treatment.
