# AskUserQuestion card — shared format (Claude / Cortana / Minion)

## Approved mock
`Features/UI-Design/mocks/index.html` `#aq1` + `e2e-artifacts/aq-card-mock-for-feedback.png`:
- Neutral chrome (no `--accent` / green)
- Click selects; **Submit answer** confirms
- **Continue without answering** (quiet)
- Footer: “Or type a reply in the composer below.”

## User flow
1. Claude, Cortana, or Minion asks → same `AskUserQuestionCard`.
2. Head: `{Claude|Cortana|Minion} is asking a question` (or N questions).
3. Select option(s) → Submit (or skip / type in composer).

## Done when
- [x] Mock `#aq1` has Submit + Continue (explicit select).
- [x] Production `global.css` AQ block uses no `--accent*`.
- [x] Submit / Next use neutral `.aq-submit` (not `.btn-allow`).
- [x] `sessionMode` → asker name on Claude / Cortana / Minion.
- [x] `npm run build` clean.
- [ ] AQ e2e currently fails at new-session `initial-prompt` (modal flake); not card chrome.
