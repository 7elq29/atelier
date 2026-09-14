# Friendlier copy for Claude Code exit 255

## Bug

When the Claude Code process dies, the transcript shows the SDK’s raw string:

`Error: Claude Code process exited with code 255`

Exit 255 is a catch-all (dropped SSH, failed resume, CLI crash). Users should
not have to decode a process exit code.

## Expected user flow

1. The assistant process stops unexpectedly (or the user reopens a session
   that already stored this raw error).
2. The chat shows a one-line, plain-language error in the existing
   system-error pill (`.msg-system`), not “exited with code 255”. The pill is
   a single centered line, so the copy stays one short sentence plus the
   retry hint.
3. The user can send a message to retry.

## UI

No new visual language: same `.msg-system` treatment as other harness
failures (`Features/UI-Design/mocks/index.html`). Copy is still prefixed with
`Error:` so it stays a system error, not a transcript notice.

## Done criteria

- Raw `Claude Code process exited with code 255` is rewritten to
  `CLAUDE_CODE_EXIT_255_NOTICE` on persist and on display (so already-saved
  rows also read clearly).
- `npm run build` clean.
- `npm run test:e2e:affected -- --base main` green for the new spec.
