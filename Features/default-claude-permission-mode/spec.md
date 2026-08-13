# Global default Claude permission mode (Settings)

## User flow

1. Open **Settings** → **Agent**.
2. Choose **Default mode** — Default, Plan mode, Accept edits, or Auto (same labels as the composer mode pill).
3. Click **Save** (same button as default model/effort).
4. Value persists in `config.json` as `defaultClaudePermissionMode`.
5. **New Claude Code sessions** start with this mode on the composer pill and in the harness `permissionMode` for the first turn.

Existing sessions keep their stored mode until the user cycles it per session.

## UI

Reuse Agent pane patterns in `SettingsPanel.tsx` (`.stitle`, `.ssub`, `.input` select) — same block as default model/effort.

## Done criteria

- [ ] `npm run build` clean
- [ ] `npx playwright test e2e/global-nav-and-settings.spec.ts` — setting saves to config; new session pill matches configured default
- [ ] `npx playwright test e2e/composer-mode-indicator.spec.ts` — unchanged default when config unset
