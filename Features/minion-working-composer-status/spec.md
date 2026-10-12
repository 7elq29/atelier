# Minion WORKING status moves above the composer

## User flow

1. Open a Minion session that is past SETUP and actively running (tools
   streaming and/or orchestrator `display_status` updating).
2. Look at the transcript: there is **no** WORKING conversation-status card
   (no spinner + progress bar + “in progress” stack).
3. Look just above the composer: a single plain tertiary status line shows the
   current Minion status text (title and/or detail from orchestrator /
   scratch chrome), same placement family as Claude’s turn/plan hint
   (`.composer-turn-status`).
4. When the turn finishes (Done / chrome cleared), the line disappears.
5. SETUP card is unchanged (still a transcript conversation-status-card).

## UI

- Reuse `.composer-turn-status` from `src/renderer/src/styles/global.css`
  (12.5px tertiary, padding above the composer box). Plain text only —
  no spinner, no progress bar, no WORKING badge.
- Prefer `detail` when present; else `title`; else omit the row.
- Do not render `minion_working` via `ConversationStatusCard` in the
  transcript.

## Done criteria

- [x] Transcript never shows `[data-status-kind="minion-working"]`.
- [x] While Minion working chrome is active, composer shows
      `[data-testid="composer-turn-status"]` with the status text.
- [x] SETUP card still appears in the transcript when applicable.
- [x] `npm run build` clean.
- [x] `npm run test:e2e:affected -- --base main` passes for selected targets.
- [x] Screenshot artifact for working state viewed against the mock tokens.
