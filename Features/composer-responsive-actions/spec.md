# Responsive composer actions

## User flow

1. With an empty or single-visual-line composer, the model/effort selector and
   Send icon sit inside the input row on its right edge. While a turn is busy,
   the Stop and queue/send icons occupy that same inline action group.
2. When explicit newlines or soft wrapping make the input multi-line, the
   complete action group moves to the right side of the composer footer so it
   never covers typed text.
3. Returning to one visual line moves the controls back into the input row.
4. Context-window usage is represented by a circular progress ring in the
   top status bar immediately after the mode control. Hover text and its
   accessible label retain exact used/maximum token counts and percentage;
   usage at or above 70% uses the warning color.
5. The top status bar no longer shows the working path. It shows the current
   mode on the left, then the context ring, and the git branch on the right.
6. Mode is always a neutral icon-and-text control: Default, Plan mode, Accept
   edits, or Auto. Clicking it and pressing Shift+Tab keep their existing
   cycling behavior.
7. The textual turn status and waiting spinner are not shown in the status bar.
8. Send and Stop share one round action slot. While idle, it is Send. While a
   turn is active, the slot shows Stop when the composer has no sendable
   content, and changes to Send/Queue as soon as the user enters text or adds
   another sendable attachment/comment.
9. During an active turn, the currently visible Send/Stop action has a subtle
   continuously moving border around its circular edge.

## UI

The supplied Cursor screenshot defines the responsive interaction, but the
existing Atelier mock does not cover it. Update
`Features/UI-Design/mocks/index.html` before implementation with:

- `.composer-primary-actions` and `.composer-primary-actions--inline` for the
  model selector plus Stop/Send controls.
- `.composer-box--multiline` for the footer placement state.
- `.context-usage-ring`, `.context-usage-track`, and
  `.context-usage-progress` for the 18px circular context indicator.
- `.context-bar-mode` for the neutral icon-and-text mode control on the left.
- `.context-usage-ring` immediately after `.context-bar-mode`.
- `.context-bar-spacer` before `.composer-context-branch` to right-align the
  branch and existing worktree/context actions.
- `.composer-turn-action-active::before` for the moving circular border around
  the single active-turn Send/Stop control.

Reuse the existing `.footer-btn`, `.send-btn`, `.stop-btn`, `.composer-footer`,
`--bg-hover`, `--border-default`, `--text-tertiary`, and `--warning` tokens.
The input reserves enough right padding for inline controls and the rendered
Markdown mirror uses the same padding. Send and Stop are 28px circles with
14px icons. The composer footer uses `4px 14px 6px` padding so the box sits
closer to the input text.

## Done criteria

- Empty, short, explicit-newline, soft-wrapped, and shortened-again input
  states place the action group correctly in a real Electron E2E.
- Model picker selection, Send, Stop, and queue/send behavior remain wired to
  their existing actions in either placement.
- The context indicator renders as a circular SVG ring immediately after the
  mode control in `.context-bar`, with exact usage in its title/accessible
  label, and is absent from `.composer-footer`.
- The working path and `Path` label are absent from `.context-bar`.
- Mode is inside `.context-bar`, absent from `.composer-footer`, and has no
  mode-specific foreground, background, or border color.
- No turn-status text or waiting spinner appears in `.context-bar`.
- Branch appears after `.context-bar-spacer`, aligned to the right beside the
  existing worktree and context actions.
- Exactly one Send/Stop button is rendered at a time. During an active turn,
  empty composer content shows Stop and sendable content shows Send/Queue.
- The visible active-turn action has a rotating border, respects reduced-motion
  preferences, and retains its existing click behavior.
- Screenshots `04-composer-unified-stop-working.png` and
  `04-composer-unified-send-working.png` cover both states of the shared action
  slot.
- Send and Stop have 28px square bounds and a 50% border radius.
- Screenshots cover one-line and multi-line states and are visually compared
  with the updated mock and supplied Cursor reference.
- `npm run build` and `npm run test:e2e:affected -- --base main` pass, subject
  only to documented pre-existing failures.
