# Note topbar matches content background (no sidebar seam)

## Bug

App/daily note topbar used `background: var(--bg-code)` while the editor
surface is `var(--bg-app)`. Against the sidebar that darker strip reads as a
gap. Session topbar has no override and blends with content.

## Expected

`.topbar--note-editor` uses `var(--bg-app)` so the chrome matches the note
body (same as sessions). No mock change required beyond matching existing
session/main-area treatment.

## Done

- [x] Note topbar background is `--bg-app`.
- [x] E2E asserts computed topbar bg equals `--bg-app` when a note is open.
- [x] Screenshot of app note topbar viewed (`e2e-artifacts/bug-note-topbar-bg-gap.png`;
  topbar + content both `#1c1a16`).
- [x] `npm run build` + affected e2e pass.
