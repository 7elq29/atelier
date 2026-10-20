# Minion elicitation card, attachments, and idle WORKING

## User flow

1. Minion agent asks a structured question (`INTERACTION_CONTENT_TYPE_ELICITATION`
   / AskUserQuestion JSON). Atelier shows the clickable **AskUserQuestion**
   card (not raw JSON).
2. User picks an option → answer is sent via `createInteraction` on the tip.
3. While Minion waits for user input (`TASK_STATUS_USER_INPUT_REQUESTED` or
   an open elicitation), **WORKING** chrome is cleared (no “Processing…”
   spinner after the question is on screen).
4. User attaches a screenshot with a message → Atelier delivers it so the
   remote agent can see the pixels (not dropped / not Error 1406).

## Screenshot send path

Verified bug (Vibe dashboard): putting a `data:` URL in
`USER_MESSAGE.attachments[]` makes the worker treat it as a **file path** under
`attachments/` — every `/` in the base64 becomes an empty directory, and the
agent reports it cannot see the image.

1. **Worker linked:** `USER_MESSAGE` with the screenshot **inlined in the
   message body** (data URL + decode instructions). `attachments[]` stays
   empty until we implement real DevPod upload → filename. JPEG keep quality
   high (~450KB budget) so UI text stays readable.
2. **Pod RUNNING but socket not live yet:** wait up to ~10s (and nudge dial)
   before falling back.
3. **Offline RPC:** same message-body inline via `createInteraction`, compressed
   to fit MySQL TEXT (~64KiB). Clear error if it still cannot fit.

## Done

- [ ] Elicitation interactions emit `ask_user_question` (and renderer also
      parses legacy raw JSON assistant rows into the card).
- [ ] `respondToPrompt` steers the selected answers to Minion.
- [ ] WORKING chrome clears on elicitation / `USER_INPUT_REQUESTED`.
- [x] Screenshots deliver via message-body data URLs (not path-like
      `attachments[]`). Live WS uses a higher JPEG budget; offline fits TEXT.
- [ ] Real DevPod `attachments/<name>` upload + `attachments: [name]` (Minion
      Web parity) — follow-up when the write RPC is known.
- [ ] `npm run build` + `npm run test:e2e:affected -- --base main`.
