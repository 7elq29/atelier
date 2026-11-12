# Renew USSO must complete login so spend bars return

## Bug

1. Spend chip shows **USSO expired · Renew USSO**.
2. User clicks **Renew USSO**.
3. Browser opens “Authentication successful! Copy-paste the state token
   below to your terminal” — but Atelier ran `usso -fetch` via `execFile`
   with **no TTY**, so there is nowhere to paste.
4. `usso` times out / returns empty; chip stays on expired; Claude Code /
   Minion / Cortana usage never reappears.

## Expected

1. **Renew USSO** uses the same interactive path as Claude Code auth
   (`uber-auth`): on macOS GUI, open Terminal, run `usso -fetch genai-api`,
   wait until a quiet token probe succeeds.
2. User pastes the state token into that Terminal (or finishes ussh login).
3. After success, spend chip reloads to the ready bars (Claude Code + named
   pools when the API returns them).
4. Fixture / e2e path unchanged: `ATELIER_SPEND_STATUS_FIXTURE=needs_usso`
   still increments the interactive counter on click without opening Terminal.
5. Spend polls never headless `-fetch` (no orphan browser tab on mount).

## Done

- [x] Manual renew goes through Terminal bootstrap (`renewGenAiAuth`).
- [x] Spend polls no longer headless `-fetch` (Renew only).
- [x] Chip shows “Complete login in Terminal…” while renewing.
- [x] Existing needs_usso e2e passes; renew counter still bumps; full
      spend-status chip describe passes.
- [x] `npm run build` + affected e2e pass.
