# Spend chip: Minion + Cursor

## User flow

1. Open Atelier with Uber network + `usso` available.
2. Look at the bottom-left sidebar spend chip (above the profile row).
3. See monthly spend bars for each available pool:
   - **Claude Code** (harness-pool total)
   - **Cortana** (when `/spendstatus/cortana` returns data)
   - **Minion** (when `/spendstatus/minion` returns data)
   - **Cursor** (when `/spendstatus/cursor` returns data; 204 = omit)
4. Click **view usage** → eng-insights individual cost page (unchanged).

## UI

Reuses existing `.spend-indicator` / `.spend-bar-*` tokens from
`Features/UI-Design/mocks/index.html` + `src/renderer/src/styles/global.css`.
No new visual language — same stacked bar blocks as Claude Code + Cortana today.
Order fixed: Claude Code → Cortana → Minion → Cursor (only bars with data).

## Done criteria

- [ ] `getSpendStatus` fetches Cortana, Minion, and Cursor in parallel (same
      auth/headers as Cortana); failures/204 degrade to omit that bar.
- [ ] Chip renders Minion and Cursor bars when present.
- [ ] `npm run build` clean.
- [ ] `npm run test:e2e:affected -- --base main` passes for selected targets.
