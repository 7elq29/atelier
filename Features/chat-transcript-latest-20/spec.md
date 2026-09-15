# Chat transcript shows the latest 20 conversations

## Bug reproduction

1. Open a session containing 21 user/assistant turns.
2. Reload and select that session.
3. The chat currently renders 20? No: it renders 40 because
   `CHAT_TRANSCRIPT_MAX_TURNS` is set to 40, so all 21 seeded turns remain
   visible and no truncation banner appears.
4. The existing E2E also encodes the wrong limit by seeding 41 turns and
   asserting that 40 remain.

## Expected user flow

1. Open or resume a session with more than 20 conversations.
2. The chat displays only the latest 20 user-turn conversations, including
   every message belonging to those turns.
3. A banner says “Showing last 20 conversations” and reports how many earlier
   conversations are hidden.
4. Older messages remain persisted and searchable; only the displayed window
   is limited.

## UI

Reuse the existing transcript truncation banner
`[data-testid="transcript-history-truncated"]` in `ChatTranscript.tsx`. The
case is not represented in `Features/UI-Design/mocks/index.html`; no new
visual treatment is introduced.

## Done criteria

- [ ] A 21-turn session renders turns 2–21 and hides turn 1.
- [ ] The banner says “Showing last 20 conversations — 1 earlier hidden”.
- [ ] `listSessionMessages` returns exactly 20 user turns while SQLite still
      contains all 21.
- [ ] The main-process log confirms the real app/session used for the
      reproduction.
- [ ] The resulting screenshot is viewed and compared with the existing
      truncation treatment.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
