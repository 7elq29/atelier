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

1. **Worker linked (preferred):** `USER_MESSAGE` over the DevPod socket with
   data-URL `attachments[]` (full-resolution; WS accepts ~200KB+ screenshots).
2. **Pod RUNNING but socket not live yet:** wait up to ~10s (and nudge dial)
   before falling back.
3. **Offline RPC:** JPEG-compress/resize the image so the inlined
   `createInteraction` body fits MySQL TEXT (~64KiB). If it still cannot fit,
   surface a clear error — do not hit Error 1406.

## Done

- [ ] Elicitation interactions emit `ask_user_question` (and renderer also
      parses legacy raw JSON assistant rows into the card).
- [ ] `respondToPrompt` steers the selected answers to Minion.
- [ ] WORKING chrome clears on elicitation / `USER_INPUT_REQUESTED`.
- [x] `streamInput` forwards image attachments over live `USER_MESSAGE`
      (data URLs). Offline path JPEG-compresses screenshots into TEXT budget.
- [ ] `npm run build` + `npm run test:e2e:affected -- --base main`.
