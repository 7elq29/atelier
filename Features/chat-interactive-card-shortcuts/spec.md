# Keyboard shortcuts for chat interactive cards

## User flow

1. When a pending question, permission, or plan card is visible, hold ⌘.
2. The existing Vimium-style keyboard-hint overlay assigns a letter badge to
   every interactive card option and action.
3. While still holding ⌘, type the displayed letter (or letter sequence) to
   invoke that control.
4. AskUserQuestion choices select exactly like a click. Single-question
   answers still require explicit Submit, and multi-question cards still
   advance through the stepper.
5. Permission and plan buttons activate through the same hint mechanism.
6. The existing `⌘1`, `⌘2`, etc. numbered sidebar-row shortcuts remain
   unchanged and never also activate a chat card.

## UI

Reuse the global keyboard hints defined by
`Features/keyboard-hints/spec.md` and `KeyboardHintsOverlay`. Permission and
plan actions are already buttons. Render `.aq-option` and
`.aq-option.aq-other` as real buttons so the existing
`button:not([disabled])` target collector includes them. Do not render
permanent shortcut labels inside cards.

The AskUserQuestion card deprecates green as an interaction-state language:

- Keep `.aq-head` green (`var(--accent)`); the title is the sole green
  treatment in this card.
- A pending `.aq-option.selected` keeps its original surface and gains a
  neutral `var(--border-strong)` border. It does not gain a green background
  or filled green radio.
- The free-text textarea uses a neutral `var(--border-strong)` focus border,
  with 8px between the Other row and `.aq-other-box`.
- `.aq-submit` uses neutral panel/hover and border/text tokens, not
  `.btn-allow`'s green background.

## Done criteria

- [ ] Every pending AskUserQuestion option, including Other, receives and
      responds to an existing keyboard-hint letter.
- [ ] Permission and plan actions respond through the same hint overlay.
- [ ] Numbered sidebar-row shortcuts do not activate card controls.
- [ ] AskUserQuestion retains explicit Submit behavior.
- [ ] Resolved cards no longer react to the shortcuts.
- [ ] Existing click behavior remains unchanged.
- [ ] Pending selected options use a neutral border with no background
      change or green radio fill.
- [ ] The Other textarea has neutral focus chrome and 8px separation.
- [ ] Submit answer has no green background; only the card title remains
      green.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass.
