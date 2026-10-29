# Chat transcript shows the latest 50 conversations

## Problem

Long sessions (e.g. Minion “Torchlight trace command”) keep every
user/assistant/tool row in the rendered transcript. Switching to that session
lags because the UI hydrates and paints the full history. Older turns must stay
in SQLite (search / resume), but the live chat surface should only hold the
recent window.

## Expected user flow

1. Open or resume a session with more than 50 user-turn conversations.
2. The chat displays only the latest 50 user-turn conversations (including
   every message belonging to those turns).
3. A banner says “Showing last 50 conversations” and reports how many earlier
   conversations are hidden.
4. Live appends (including Minion WS full replay) must not grow the in-memory
   transcript past that window — older turns drop from the UI as newer ones
   arrive; SQLite still keeps the full history.

## UI

Reuse `[data-testid="transcript-history-truncated"]` in `ChatTranscript.tsx`.
Not represented in `Features/UI-Design/mocks/index.html`; no new visual
treatment.

## Done criteria

- [x] A 51-turn session renders turns 2–51 and hides turn 1.
- [x] Banner: “Showing last 50 conversations — 1 earlier hidden”.
- [x] `listSessionMessages` returns exactly 50 user turns while SQLite still
      contains all 51.
- [x] Live `session:message` appends trim via `windowMessagesForDisplay` so the
      renderer store stays within 50 user turns (Minion full-replay safe).
- [x] Screenshot `e2e-artifacts/chat-transcript-window-51-turns.png` viewed.
- [x] `npm run build` clean; `e2e/chat-transcript-window.spec.ts` passes.
      (`test:e2e:affected -- --base main` also pulled unrelated audit /
      secondary-panels / bookmark log-string failures; not caused by this
      window change.)

