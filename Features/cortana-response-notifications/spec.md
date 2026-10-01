# Cortana response notifications

## Bug

When a Cortana turn finishes, the user gets no "response ready" affordances:
no orange corner dot on the session row, no collapsed-sidebar "Agent ready"
chip/banner. Claude Code already shows these.

## Expected user flow

1. Open two Cortana sessions. Stay on session A.
2. Send a message in A; wait until the turn finishes while still on A.
3. Switch to session B.
4. Session A's row shows the orange waiting-input alert dot
   (`session-waiting-input-alert`).
5. With the sidebar collapsed, session A appears as an "Agent ready" chip.

OS desktop "Response ready" (already Cortana-only, window-unfocused) stays
as-is — this bug is the in-app alert path.

## Root cause

`sessionLiveWaitingForInput` in `Sidebar.tsx` returns false unless
`mode === 'claude-code'`, so Cortana never enters `waitingInputAlertIds`.

Secondary: Cortana `createSession` with an initial prompt never sets
`live.busy = true`, so the first turn may never show a working→waiting
transition.

## Done criteria

- [x] `sessionLiveWaitingForInput` treats Cortana like Claude Code.
- [x] Cortana create with a prompt marks the live stream busy (parity).
- [x] E2E: Cortana orange dot after respond-then-switch-away.
- [x] `npm run build` and `npm run test:e2e:affected -- --base HEAD` pass.
