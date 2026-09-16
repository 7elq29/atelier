# Move the Timeline panel toggle to the topbar

## Expected user flow

1. Open any session, note, or empty workspace.
2. Find the Timeline panel toggle at the far-right end of the main title bar.
3. Click it to open the existing Daily Notes / Timeline panel.
4. Click it again to close the panel.
5. The sidebar retains only its collapse and Settings utility buttons.

## Expected UI

Update `Features/UI-Design/mocks/index.html`: remove the book toggle from
`.sidebar-utility-row` and add it as the last child of `.topbar`, after any
search controls. Reuse the existing 24px utility-button proportions, 14px
monoline book icon, `--text-tertiary`, `--bg-hover`, and `--r-sm`. The new
`.topbar-timeline-toggle` is pushed to the far right and uses its active
treatment while the panel is open.

## Done criteria

- [ ] The sidebar utility row contains only Collapse and Settings.
- [ ] `[data-testid="toggle-daily-notes-panel"]` is the last visible topbar
      control and its right edge is within the topbar's right padding.
- [ ] The button remains 24px square with a 14px icon.
- [ ] Clicking it opens and closes `[data-testid="daily-notes-panel"]` and
      updates `aria-pressed`.
- [ ] `e2e-artifacts/timeline-toggle-topbar.png` is personally compared with
      the supplied example and the updated mock.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
