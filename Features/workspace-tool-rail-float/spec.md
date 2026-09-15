# Float the workspace tool icons

## Expected user flow

1. Open a Claude Code session on Chat.
2. Diff, Files, Terminal, and (when present) Ports stay as the same vertical
   icons at the right edge of the session workspace, immediately left of Daily
   Notes.
3. Those icons no longer occupy a dedicated column. Chat, the composer, and
   any open tool pane use the full workspace width; the icons float over the
   right edge.

## Expected UI

`Features/UI-Design/mocks/index.html` does not define this overlay. Keep the
live `.workspace-tool-rail` / `.workspace-tool-button` treatment from
`Features/secondary-tool-rail/spec.md`: no rail background, border, or
selected fill; 36px hit targets around 22px icons; hover/active change only
icon color. Position the rail absolutely on the workspace right edge,
vertically centered, with clicks passing through empty rail space.

## Validation / done criteria

- A real Electron E2E test with a live session asserts the rail is
  `position: absolute` and that `[data-main-content]` is the same width as
  `.workspace-shell`.
- The same test confirms the icons still open Diff.
- Screenshot `e2e-artifacts/workspace-tool-rail-floating.png` is personally
  compared with the previous reserved-column screenshot.
- `npm run build` and `npm run test:e2e:affected` pass.
