# Local terminal sidebar

## User flow

1. Sidebar shows **Sessions** (agent rows + history) and **Terminals** (terminal-mode rows), separated by a horizontal rule that sits immediately under the session list (natural document flow, not pinned to the sidebar bottom).
2. **Sessions** header row: label on the left, ghost **+** icon on the right → opens the existing New Session modal.
3. **Terminals** header row: label on the left, ghost **terminal** icon on the right → one click creates a **local** terminal-only session (no modal), selects it, and shows the terminal in the main area.
4. Terminal row meta shows **Local** when the shell is local; when the user `ssh`s to a host from that terminal, meta updates to that host; when the SSH session ends, meta returns to **Local**. Remote terminal sessions created via the modal still show their configured `hostname`.

## Done criteria

- `npm run build` clean.
- `npx playwright test e2e/secondary-panels.spec.ts` (terminal specs) pass, including a new case for `open-local-terminal-button`.
