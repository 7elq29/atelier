# Chat transcript typography and user input

No tool-detail or composer chrome changes.

## Regression: assistant text wraps too early

The supplied screenshot shows assistant prose using only about 70% of its
intended reading column. `.msg-wrap` already owns the responsive
`min(84%, 720px)` measure; applying that cap again to its child
`.msg-assistant` compounds the width to 84% × 84%.

Expected: `.msg-wrap` remains the single width owner and `.msg-assistant`
fills it (`width: 100%; max-width: none`). At a wide window, the assistant
message and its wrapper must have the same computed width. This case is not
shown separately in the mock; it follows the mock's existing 84%/720px
assistant measure without applying it twice.

## Regression: composer cursor offset

The Notes-style Markdown layer wraps the textarea in `.composer-input-stack`,
which changes the textarea's `offsetParent`. The custom block cursor must be
positioned from the textarea and `.composer-box` bounding rectangles, not by
adding `textarea.offsetTop/offsetLeft`. With a context bar present, the cursor
must remain inside the visible textarea bounds at the active selection.
Its height must match the 15.5px input font (`1em`), centered within the 1.7
line box; using the full line-height makes the cursor visibly oversized.

## User flow

1. The user opens a chat session and reads an assistant reply that has
   paragraphs, headings, lists, and inline code.
2. The reply uses the same 15.5px agent-message size as before.
3. Paragraphs, headings, and list items have more space between them, so
   the answer scans as a document instead of a packed text wall.
4. Inline code stays monospaced but does not form a high-contrast chip
   grid across the prose.
5. User input stays right-aligned. Its background is a slight lift of the
   chat background (panel mixed into `--bg-app` at 25%). The border is a
   lighter warm gray mixed from `--text-disabled` into `--bg-panel`, not
   a more-opaque white hairline. It does not reuse the green accent.
6. User input Markdown renders in the sent bubble using the same paragraph,
   heading, list, link, and code treatment as an assistant response. Its
   15.5px type and 1.7 line-height use the same reading rhythm, avoiding the
   compact block shown in the supplied reference.
7. The composer uses the same Atomic CodeMirror live-preview editor as Notes:
   formatting renders inline while the active line remains editable Markdown.
   Mentions, slash commands, paste, Enter-to-send, and Shift+Enter newline
   behavior remain available, and sending transmits the unchanged source.
8. The transcript has more side breathing room at normal widths, scaling
   down smoothly when a side panel narrows the chat.

## UI

Reuse the existing `.msg-assistant` / `.md-body` selectors in
`src/renderer/src/styles/global.css` and the matching rules in
`Features/UI-Design/mocks/index.html`. Tokens: `--font-agent-message-size`
(15.5px), `--font-ui`, `--font-mono`.

| Surface | Treatment |
| --- | --- |
| Assistant body | 15.5px, `line-height: 1.7`, measure `min(84%, 720px)` |
| Paragraphs | `margin: 0 0 16px` |
| Headings | weight 600, `margin: 24px 0 10px` |
| Lists | `margin: 0 0 12px`; `li + li { margin-top: 8px }` |
| Inline code | `font-size: 0.9em`, `padding: 0 3px`, tint mixed toward transparent |
| User input | right-aligned, 15.5px/1.7, assistant Markdown rhythm, `color-mix(in srgb, var(--bg-panel) 25%, var(--bg-app))`, border `color-mix(in srgb, var(--text-disabled) 70%, var(--bg-panel))`, 10px radius |
| Composer Markdown | Notes' `AtomicCodeMirrorEditor`, themed into the existing composer and capped at the existing 160px auto-grow height |
| Transcript margins | `clamp(20px, 6%, 64px)` horizontal padding |

The mock does not cover Markdown composition. The chosen treatment reuses the
Notes inline editor inside the existing composer box, without adding a panel
or mode toggle. Tool cards and all non-input composer chrome are unchanged.

## Done

- [ ] `npm run build` is clean.
- [ ] Affected E2E includes the markdown rendering test in
      `e2e/ui-chat-transcript-typography.spec.ts`, asserts the computed
      type scale and neutral user-input surface, verifies inline Markdown
      in the composer and sent user bubble, and verifies that
      transcript padding decreases with the chat pane width.
- [ ] At a 1400px window, the assistant message fills its `.msg-wrap`
      container instead of receiving a second 84% width cap.
- [ ] Screenshots `bug-chat-assistant-double-width-cap.png` and
      `chat-assistant-width-after.png` personally compared to confirm the
      corrected reading measure.
- [ ] With the composer context bar visible, `.composer-cursor` remains
      within the textarea bounds instead of appearing above the input.
- [ ] The cursor's computed height equals the composer's computed font size.
- [ ] Screenshot `composer-cursor-position-after.png` personally viewed
      against the supplied broken-state screenshot.
- [ ] Screenshot `e2e-artifacts/ui-chat-transcript-typography.png` viewed
      against the mock and supplied Cursor reference: paragraphs read with
      a clear gap, inline code is quieter than a chip, and user input is
      distinct without accent-green fill.
- [ ] Screenshot `e2e-artifacts/ui-composer-inline-markdown.png` personally
      viewed: the textarea remains editable while inactive Markdown lines
      render with the same Notes-style inline treatment.
