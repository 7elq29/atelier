# Chat transcript typography and user input

No tool-detail or composer chrome changes.

## Regression: assistant text wraps too early

The fullscreen screenshots show that a fixed 720px reading measure wastes
most of a wide chat surface and forces replies to wrap too early. The earlier
double-width bug also applied the message percentage to both `.msg-wrap` and
its child `.msg-assistant`.

Expected: the complete chat body, including the transcript/tracker region and
composer, occupies 60% of the available main surface and remains centered on
wide panels, matching the supplied Cursor screenshot. It has a 1080px
preferred minimum: when 60% would be narrower than 1080px, the equal outer
margins shrink first; on panels below 1080px, it uses all available width
without overflowing. `.msg-wrap` uses the existing
responsive 84% measure with no fixed pixel cap, and `.msg-assistant` fills that
wrapper (`width: 100%; max-width: none`). Thus both the reading width and the
composer grow and shrink with the containing panel rather than stopping at
1080px. The mock did not previously cover a shared transcript/composer width;
add the 60% treatment to `.chat-body-row` and `.composer-wrap`.

## Regression: composer cursor offset

The Notes-style Markdown layer wraps the textarea in `.composer-input-stack`,
which changes the textarea's `offsetParent`. The custom block cursor must be
positioned from the textarea and `.composer-box` bounding rectangles, not by
adding `textarea.offsetTop/offsetLeft`. With a context bar present, the cursor
must remain inside the visible textarea bounds at the active selection.
Its height must match the 15.5px input font (`1em`), centered within the 1.7
line box; using the full line-height makes the cursor visibly oversized.

## Regression: route text is mistaken for file links

The supplied screenshot shows URL-route fragments such as `/v/`,
`/v-staging/…`, and `/v-staging/logging-mcp-conformance-staging/` rendered as
green links even though they are neither web URLs nor files known to the
session workspace.

Expected user flow:

1. The user reads an assistant response containing route fragments, a known
   workspace file, and an `http(s)` URL.
2. Route fragments remain ordinary body text and do nothing when clicked.
3. A file mention becomes a link only when the session file inventory can
   resolve it to an openable full path.
4. Explicit Markdown and bare `http(s)` web links remain links.
5. File and web links use the existing blue `--info` token at normal font
   weight and gain an underline only on hover. They do not use green accent
   color or bold text.

The mock's global `a` rule currently uses green `--accent`; update it and the
chat `.md-body a` rule to blue `--info`, preserving the existing hover
underline. No new link component or visual treatment is introduced.

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
9. The block cursor remains aligned with the Atomic live-preview text after
   decorated content such as a bare external URL. Typing inserts at the exact
   position indicated by the cursor.

## Composer cursor bug

The textarea is still the input source, but Atomic CodeMirror is the visible
text layer. The old block cursor is measured in a hidden plain-text mirror,
which cannot account for Atomic decorations such as the external-link icon.
After a decorated URL, the visible text moves right while the cursor stays at
the undecorated source coordinate.

The mock does not cover this caret/decorations case. Keep the existing block
cursor treatment, but source its coordinates from CodeMirror's
`EditorView.coordsAtPos()` whenever the Atomic layer is mounted. Use the
textarea mirror only for empty input before Atomic mounts. Use CodeMirror's
complete caret rectangle (`left`, `top`, and `bottom`) to find the rendered
line center, then center a block whose height is the Atomic content's actual
font size inside that rectangle.

## UI

Reuse the existing `.msg-assistant` / `.md-body` selectors in
`src/renderer/src/styles/global.css` and the matching rules in
`Features/UI-Design/mocks/index.html`. Tokens: `--font-agent-message-size`
(15.5px), `--font-ui`, `--font-mono`.

| Surface | Treatment |
| --- | --- |
| Chat body and composer | centered, `width: max(60%, min(1080px, 100%))`; margins shrink before content |
| Assistant body | 15.5px, `line-height: 1.7`, responsive `84%` measure with no fixed pixel cap |
| Paragraphs | `margin: 0 0 16px` |
| Headings | weight 600, `margin: 24px 0 10px` |
| Lists | `margin: 0 0 12px`; `li + li { margin-top: 8px }` |
| Inline code | `font-size: 0.9em`, `padding: 0 3px`, tint mixed toward transparent |
| User input | right-aligned, 15.5px/1.7, assistant Markdown rhythm, `color-mix(in srgb, var(--bg-panel) 25%, var(--bg-app))`, border `color-mix(in srgb, var(--text-disabled) 70%, var(--bg-panel))`, 10px radius |
| Composer Markdown | Notes' `AtomicCodeMirrorEditor`, themed into the existing composer and capped at the existing 160px auto-grow height |
| Transcript margins | `clamp(20px, 6%, 64px)` horizontal padding |
| File and web links | `--info`, inherited font weight, no resting underline; underline on hover |

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
- [x] On wide surfaces, `.chat-body-row` and
      `.composer-cache-entry.active` each occupy 60% of their containing
      surface and have equal left/right outer space.
- [x] When 60% would be below 1080px, both surfaces remain
      `min(1080px, 100%)` wide and reduce their equal outer margins instead.
- [ ] The assistant wrapper computes to 84% of the transcript content width
      with no 720px ceiling, and `.msg-assistant` fills that wrapper instead
      of receiving a second width cap.
- [ ] Screenshots `bug-chat-assistant-double-width-cap.png` and
      `chat-fullscreen-responsive-width-after.png` personally compared to
      confirm the corrected responsive measure and aligned composer.
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
- [ ] A real assistant response containing `/v/`, `/v-staging/…`, and
      `/v-staging/logging-mcp-conformance-staging/` renders those fragments
      as plain text while linking known `README.md` and
      `https://example.com`.
- [ ] File and web links compute to `--info`, normal font weight, no resting
      underline, and underline on hover.
- [ ] The supplied screenshot and the initial failing E2E screenshot capture
      the broken state; corrected `chat-file-and-web-links-after.png` is
      personally compared against them.
- [ ] A real Electron regression types a bare URL followed by `and i`, proves
      the textarea source caret and Atomic document selection agree, and
      asserts the visible block cursor is at CodeMirror's rendered coordinate,
      matches Atomic's rendered font size, and is centered in its line box.
- [ ] Screenshot
      `e2e-artifacts/bug-composer-cursor-after-decorated-link.png` shows the
      cursor immediately after `i`, and the app log proves the real session
      used for the reproduction initialized successfully.
