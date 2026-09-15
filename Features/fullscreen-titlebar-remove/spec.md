# Remove the blank title bar in macOS fullscreen

## Bug reproduction

1. Open Atelier on macOS.
2. Enter native fullscreen using the green window control.
3. The macOS traffic lights disappear, but Atelier continues rendering its
   40px integrated `.title-bar`.
4. The result is the blank horizontal strip shown in the supplied screenshot,
   above the sidebar and workspace.

## Expected user flow

1. In a normal macOS window, Atelier keeps the integrated title bar, centered
   app name, drag region, and native traffic-light inset.
2. Enter native fullscreen.
3. The integrated title bar disappears and `.app-body` expands to the top edge.
4. Leave fullscreen; the title bar returns without relaunching.

## UI

`Features/UI-Design/mocks/index.html` defines the normal-window `.title-bar`
as a 40px drag strip for `hiddenInset` chrome. It does not define a fullscreen
variant. In fullscreen, hide that same component entirely rather than adding
new chrome, spacing, or tokens.

## Done criteria

- [ ] A macOS Electron E2E reproduces the visible blank strip before the fix.
- [ ] Entering native fullscreen hides `[data-testid="window-title-bar"]`.
- [ ] The app body reaches the top edge while fullscreen.
- [ ] Leaving fullscreen restores the integrated title bar.
- [ ] Main-process logs confirm both fullscreen transitions.
- [ ] The fixed fullscreen screenshot is personally compared with the supplied
      screenshot and normal-window mock.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
