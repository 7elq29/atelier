# Files editor unsaved buffer

Editing a file in the **Files** panel and then clicking another file in the tree
silently destroyed the edit: `openInCurrentTab` reuses the active tab, resets
`isDirty: false`, and `disposeModelForPathIfUnused` throws away the Monaco model
that held the typed text. Only `⌘S` ever calls `filesWrite`, and the sole cue
that work was pending was a 6px `--text-tertiary` dot.

## User flow

1. In the **Files** tab, open a file and type. The tab, the tree row, and a
   badge in the tab strip all mark the file as unsaved.
2. Click a different file in the tree (or the location bar / quick-open). The
   first file's edited text is mirrored to a **buffer file** on disk; the real
   file is untouched, so `git status` still shows it unchanged.
3. Re-open the first file. The editor shows the **buffered edit**, not the disk
   content, and the file still reads as unsaved.
4. `⌘S` writes the buffer to the real file (local `fs` or remote `cat >` over
   SSH), deletes the buffer file, and clears every unsaved marker.
5. Closing a tab with pending edits keeps its buffer, so re-opening the path
   restores the text.
6. Buffers are scoped to one app run: quitting Atelier discards them, and a
   relaunch shows real file contents again.

## Storage

`<userData>/editor-buffers/<sha256(host|path)>.json`, each holding
`{ path, hostname, content, updatedAt }` — the key is hashed because absolute
paths exceed the 255-byte filename limit, with the readable path kept inside for
debugging. Writes are debounced 400ms while typing (matching `useDailyNote`'s
write debounce) and flushed before switching files. `purgeEditorBuffers()` runs
both at startup (clearing crash leftovers) and on `before-quit`.

## UI

Mock (`Features/UI-Design/mocks/index.html` + `shared.css`) has no Files editor
tab strip, so this follows the established secondary-panel treatment already used
by `.files-editor-tabs` / `.files-editor-tab` in `global.css`:

- `.files-unsaved-badge` — right-aligned in the `.files-editor-tabs` strip,
  reusing the `.profile-badge` pill recipe already in the Files panel
  (`padding: 2px 8px; border-radius: 100px`). `tokens.css` has `--warning` but no
  `--warning-dim`, so the fill uses `color-mix(in srgb, var(--warning) 16%,
  transparent)` — the same technique as the `--atomic-editor-search-bg` rules in
  `global.css` — instead of adding a token. Text: `Unsaved · ⌘S`, or
  `<n> unsaved · ⌘S` for multiple files.
- `.files-tab-dirty` and the tree row dot go 6px → 7px and switch from
  `--text-tertiary` to `--warning`, so pending edits read as pending rather than
  as disabled text.

## Done criteria

- `openInCurrentTab` restores from the buffer instead of the disk read when one
  exists; neither dispose site drops a model with a live buffer.
- `saveCurrentFile` deletes the buffer and clears markers; `panel:files:write`
  now logs, so saves are greppable in `main.log` (they were invisible before).
- E2e in `secondary-panels.spec.ts`: type into `src/index.js`, assert badge +
  dirty markers, navigate away and back, assert the edited text is still in
  Monaco while the file on disk is unchanged, then `⌘S` and assert disk content
  plus badge clearing. Relaunch and assert buffers were purged.
- Screenshot `e2e-artifacts/07-files-unsaved-buffer.png` viewed and compared
  against the panel treatment above.
- `npm run build` clean; targeted category 10 run
  (`secondary-panels.spec.ts`, `terminal-pty.spec.ts`,
  `bug-diff-preload-limit.spec.ts`).
