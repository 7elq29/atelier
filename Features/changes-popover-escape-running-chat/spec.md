# Escape closes the changes popover without stopping chat

## Bug reproduction

1. Start a Claude Code turn that is still running.
2. Open the composer **Changes** popover (`data-testid="chat-uncommitted-changes"`).
3. Press Escape.
4. Current bug: the popover closes and the same Escape also interrupts the
   active chat turn (`harness.interrupt() called` appears in the main log).

## Expected flow and UI

1. With a Claude Code turn running and at least one changed file in the cap,
   click the Changes icon.
2. The existing popover opens — same `.chat-changes-popover` treatment as
   `Features/UI-Design/mocks/index.html` / `Features/chat-uncommitted-changes`.
3. Press Escape.
4. Only the popover closes. The composer still shows Stop and the running
   turn completes normally.

No visual redesign. This only changes keyboard-event ownership so Escape
dismisses the popover the same way it already dismisses the command palette.

## Done criteria

- [ ] A real Electron/SDK E2E reproduces the interrupt before the fix.
- [ ] Escape closes `[data-testid="chat-uncommitted-changes"]`.
- [ ] The active turn remains busy immediately afterward and completes.
- [ ] The post-Escape main log contains no new `harness.interrupt() called`.
- [ ] Before/fixed screenshots are personally inspected.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
