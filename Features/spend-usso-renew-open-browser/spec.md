# Renew USSO: linked weblogin wait/callback (no paste page)

## Workflow

1. **Quiet check** (poll / mount): `usso -ussh genai-api -print`.
   - JWT → fetch spendstatus → Claude Code / Cortana / Minion bars.
   - Fail → chip shows **USSO expired · Renew USSO**. No auto browser tabs.
2. **Renew USSO**: start `usso -fetch genai-api -print` on a **hidden PTY**
   first so the CLI is `Waiting for Authentication` (wait/callback registered).
3. Only then open the **weblogin URL usso printed** in the system browser.
4. User completes Okta/SSO. usso receives the offline token via its wait /
   callback path — **not** the copy-paste state-token page (that page appears
   when weblogin is opened *before* usso is waiting).
5. Quiet print succeeds → spend bars reload.

Never open macOS Terminal.app or Atelier’s terminal UI for this flow.

## Done

- [x] Polls: quiet only; no auto browser.
- [x] Renew: PTY `usso -fetch` first, then open linked weblogin URL.
- [x] JWT extraction ignores “Enter the state token…” prompts.
- [x] E2e fixture still counts `webloginOpenCount` on Renew click.
- [x] `npm run build` + spend-status chip e2e pass.
