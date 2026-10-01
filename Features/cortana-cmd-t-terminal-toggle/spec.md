# Cortana ⌘T terminal toggle

## Expected user flow

1. In an active Cortana session (not disconnected), press ⌘T.
2. If Terminal is closed, it opens in the right split. If Terminal is already
   open, ⌘T closes it and returns focus to Chat.
3. ⌘D / ⌘F / ⌘P do nothing in Cortana (those tools are not available).
4. Hold-⌘ hint badges still show `t` on the Terminal tool button and activate
   the same toggle.

## Expected UI

Reuse existing workspace tool rail / split behavior. No new chrome.
Cortana rail already limits tools to Terminal
(`allowedTools={['terminal']}`).

## Done criteria

- [x] ⌘T opens Terminal on Cortana; pressing again closes it.
- [x] ⌘D/⌘F/⌘P do not open Diff/Files/Ports on Cortana.
- [x] E2E covers Cortana ⌘T toggle; `npm run build` and
      `npm run test:e2e:affected -- --base main` pass.
