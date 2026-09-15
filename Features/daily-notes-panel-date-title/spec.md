# Daily Notes panel header is the date only

## User flow

1. Open the Daily Notes side panel (it opens with a vault date).
2. The panel header shows that date (`2026-09-15`), not `Daily Notes —`
   in front of it.
3. Close still lives on the same `.dn-head` row.

## UI

`Features/UI-Design/mocks/index.html` `.daily-notes-panel .dn-head .dtitle`
currently reads `Daily Notes — Jul 30` (book icon + prefix). The mock does
not show date-only. Reuse `.dn-head` / `.dtitle`; put only the date in
`.dtitle`. Vault-not-configured and loading still say `Daily Notes` because
there is no note date to lead with.

## Done criteria

- [ ] Dated panel `.dtitle` is the ISO date string, with no `Daily Notes`
      prefix.
- [ ] Screenshot `e2e-artifacts/daily-notes-panel-date-title.png` viewed
      against the user’s crop.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
