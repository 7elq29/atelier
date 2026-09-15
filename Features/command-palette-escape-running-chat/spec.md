# Escape closes the command palette without stopping chat

## Bug reproduction

1. Start a Claude Code turn that is still running.
2. Open the command palette with Command-K on macOS or Alt-X elsewhere.
3. Press Escape.
4. Current bug: the palette closes and the same Escape also interrupts the
   active chat turn (`harness.interrupt() called` appears in the main log).

## Expected flow and UI

1. With a Claude Code turn running, open the command palette.
2. Press Escape.
3. Only the command palette closes. The composer still shows Stop and the
   running turn completes normally.

The command palette visuals do not change. The existing mock
`Features/UI-Design/mocks/index.html` covers the palette surface; this fix
only changes keyboard-event ownership.

## Done criteria

- [ ] A real Electron/SDK E2E reproduces the interrupt before the fix.
- [ ] Escape closes `[data-testid="command-palette"]`.
- [ ] The active turn remains busy immediately afterward and completes.
- [ ] The post-Escape main log contains no new `harness.interrupt() called`.
- [ ] Before/fixed screenshots are personally inspected.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
