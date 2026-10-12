# Minion elicitation card, attachments, and idle WORKING

## User flow

1. Minion agent asks a structured question (`INTERACTION_CONTENT_TYPE_ELICITATION`
   / AskUserQuestion JSON). Atelier shows the clickable **AskUserQuestion**
   card (not raw JSON).
2. User picks an option → answer is sent via `createInteraction` on the tip.
3. While Minion waits for user input (`TASK_STATUS_USER_INPUT_REQUESTED` or
   an open elicitation), **WORKING** chrome is cleared (no “Processing…”
   spinner after the question is on screen).
4. User attaches an image with a message → bytes are included in the steer
   payload the remote agent can read (not dropped by `_attachments`).

## Done

- [ ] Elicitation interactions emit `ask_user_question` (and renderer also
      parses legacy raw JSON assistant rows into the card).
- [ ] `respondToPrompt` steers the selected answers to Minion.
- [ ] WORKING chrome clears on elicitation / `USER_INPUT_REQUESTED`.
- [ ] `streamInput` forwards image attachments (not ignored).
- [ ] `npm run build` + `npm run test:e2e:affected -- --base main`.
