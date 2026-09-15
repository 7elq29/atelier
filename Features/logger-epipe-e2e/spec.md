# E2E logging ignores a closed stdout pipe

## Bug reproduction

1. Launch the real Electron app from Playwright.
2. Let the test runner close its read end of the Electron stdout pipe while
   the app is still shutting down or emitting background logs.
3. Trigger another structured main-process log entry.
4. Current bug: `logger.write()` mirrors through `console.log()`, Node emits
   an unhandled `EPIPE`, and Electron shows “A JavaScript error occurred in
   the main process.”

The supplied screenshot shows the native error dialog and its
`console.log → write EPIPE` stack. The app's real `main.log` still contains
the triggering entry, proving the file logger succeeded and only stdout
mirroring failed.

## Expected behavior

- Continue writing structured entries to `logs/main.log`.
- If stdout reports `EPIPE`, disable only stdout mirroring for the remainder
  of that process.
- Do not show an uncaught-exception dialog.
- Do not swallow non-`EPIPE` stdout errors.

This is teardown/error handling only. The UI mock does not cover native
JavaScript exception dialogs, and no visual treatment changes.

## Done criteria

- [ ] A real Electron E2E closes the stdout consumer and reproduces `EPIPE`
      before the fix.
- [ ] The same E2E observes no uncaught exception after the fix.
- [ ] The probe entry remains present in the real `main.log`.
- [ ] The app remains responsive after the broken pipe.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
