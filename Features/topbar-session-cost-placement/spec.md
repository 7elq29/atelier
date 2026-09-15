# Session cost sits beside the session title

## User flow

1. Open a Claude Code session.
2. The session name is in the topbar title.
3. The session spend (`$12.34`) appears immediately to the right of that
   title, before the workspace path and tab strip.
4. The amount is grey (`--text-tertiary`), not the previous right-aligned
   chip color.

## UI

`Features/UI-Design/mocks/index.html` does not place session spend next to
the title. Reuse `.topbar-title-group` and `.title`; style the amount with
`--text-tertiary` (same token as `.topbar-workspace`). No new chrome.

## Done criteria

- [ ] Cost chip is to the right of `[data-testid="main-title"]` and left of
      the tab strip.
- [ ] Computed color is `--text-tertiary`.
- [ ] Screenshot compared with the user’s topbar crop.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
