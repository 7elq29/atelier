# Double-Escape chat interrupt

## Expected user flow

1. Start a prompt and wait until the chat is actively running.
2. Press Escape once. The run continues.
3. Press Escape again within 600 ms. Atelier interrupts the active run using
   the same behavior as the Stop button.
4. Holding Escape must not interrupt through keyboard repeat.
5. Escape still closes command palettes, popovers, transcript search, and
   other overlays with one press; that press does not count toward the
   running-chat double press.

## Expected UI

No visual treatment is added. The mock does not define a double-Escape hint,
so existing chat, composer, and Stop-button styles remain unchanged.

## Done criteria

- [ ] One Escape during a real active SDK turn does not write
      `harness.interrupt() called` to the main log.
- [ ] A second Escape within 600 ms interrupts that turn.
- [ ] Auto-repeat cannot satisfy the second press.
- [ ] Existing one-Escape overlay dismissal remains unchanged.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass,
      except independently confirmed pre-existing failures.
