# Compact sidebar utilities at the top

## User flow

1. Open the app with the sidebar expanded.
2. Collapse sidebar, Daily Notes, and Settings controls appear together on
   the same top row as **+ New Group**.
3. Use any control exactly as before.
4. The decorative purple profile dot is no longer shown.

## UI

The current mock in `Features/UI-Design/mocks/index.html` places
`.sidebar-bottom` after the spend indicator and includes `.user-avatar`.
Update the mock and live UI to replace that footer with a
`.sidebar-top-row`: **+ New Group** on the left and `.sidebar-utility-row`
on the right.

- Remove `.user-avatar`.
- Use three 24px square utility buttons with 14px monoline SVG icons.
- Use a 2px gap so the controls read as one compact group.
- Right-align the utility group beside **+ New Group**, using existing
  `--text-tertiary` color and
  `--bg-hover` hover treatment.
- Keep the collapse control available when collapsed; Daily Notes follows
  its existing expanded-only behavior.

## Done criteria

- [ ] No `.user-avatar` is rendered.
- [ ] The three utility controls share one row with **+ New Group**.
- [ ] All three buttons are 24px square and all icons are 14px square.
- [ ] Horizontal spacing between adjacent controls is 2px.
- [ ] Collapse, Daily Notes, and Settings interactions still work.
- [ ] `e2e-artifacts/sidebar-top-utility-icons.png` is personally inspected
      against the updated mock and the supplied crop.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
