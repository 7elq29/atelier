# USSO expiry must not open endless browser tabs

## Bug reproduction

1. Let USSO / genai-api auth expire (or clear the offline token).
2. Leave Atelier open with the sidebar spend chip mounted (polls every 5 min,
   plus on mount).
3. Observed: each `spendStatus:get` runs `usso -fetch genai-api -print` (and
   on 401, `-force`), which opens a new browser login tab every poll — endless
   tabs while the user ignores them.
4. The Claude Code / Cortana spend bars disappear (`null`), with no way to
   renew from the UI.

## Expected user flow

1. When a quiet token probe fails (expired / missing USSO), Atelier may open
   the browser login **at most once** for that process.
2. If the user does not finish login, further spend polls **must not** open
   another tab (quiet probe only).
3. Where the spend chip normally shows Claude Code / Cortana usage, show a
   short “USSO expired” state with a **Renew USSO** link.
4. Clicking **Renew USSO** runs one interactive `usso -fetch` (opens the
   browser again intentionally). On success, the spend bars reload.

## UI

Reuse `.spend-indicator` / `.spend-indicator-link` in the sidebar (same place
as `SpendStatusChip`). Mock (`Features/UI-Design/mocks/index.html`) only has
the live “view usage” footers — expired state is not in the mock; keep the
same tertiary text + underline link language, no new chrome.

## Done criteria

- [x] Quiet path uses `usso -ussh genai-api -print` (no browser).
- [x] Interactive `-fetch` from the spend poll runs at most once per process
      until a successful renew.
- [x] 401 retry does not `-force` in a loop.
- [x] Chip shows renew link when auth is required; click invokes renew IPC.
- [x] `ATELIER_DISABLE_SPEND_STATUS=1` still hides the chip.
- [x] E2E covers needs-usso UI + single auto-fetch gate (counter).
- [x] `npm run build` clean; spend-status chip e2e (disabled / needs_usso / live)
      all pass. Affected also ran full `global-nav-and-settings` via preload →
      shell-boot; two unrelated failures there (default-model timeout, Tab/modal
      backdrop) — not caused by the USSO gate.
