# Global default Claude model (Settings)

## User flow

1. Open **Settings** (sidebar gear or command palette).
2. Select the **Agent** pane.
3. Edit **Default model** — any model id the SDK accepts (curated picker ids or power-user ids like `claude-sonnet-4-6[1m]`).
4. Click **Save**. The app validates the id against the live SDK (`Query.setModel()` on a short-lived probe session), same ground truth as `/model <id>` in the composer.
5. On success, the value persists in `config.json` as `defaultClaudeModel`.
6. **Default effort** — Low / Medium / High select; saved with the same **Save** button (no SDK validation).
7. **New agent sessions** start with this model and effort (harness `start`/`startWithId`, persisted `modelSelection` on the session row, composer picker initial state).

Existing sessions keep their stored model unless the user changes the picker.

## UI

Reuse Settings modal patterns from `Features/UI-Design/mocks/index.html` via existing classes: `.settings-dialog`, `.settings-nav`, `.settings-pane`, `.setting-row`, `.field-label`, `.field-hint`, `.input`, `.btn.btn-sm.btn-primary` (same as Vault pane in `SettingsPanel.tsx`).

## Done criteria

- [ ] `npm run build` clean
- [ ] `npx playwright test e2e/global-nav-and-settings.spec.ts` — invalid model rejected; valid model saved to config
- [ ] Targeted test: new session `session_started` log reports configured default (can pre-seed config or save via UI)
- [ ] Screenshot of Agent settings pane in `e2e-artifacts/` viewed against mocks
