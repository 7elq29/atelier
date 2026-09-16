# Obsidian-backed app notes

## User flow

1. In **Settings → Vault**, the user configures an **Atelier notes folder**,
   relative to the existing Obsidian vault root. Without a configured vault and
   notes folder, Atelier explains that a vault must be configured before an app
   note can be created.
2. On the first load after the folder is configured, existing database app
   notes are exported to Markdown files in that folder. The file system is then
   the source of truth; the legacy database rows remain as a migration backup
   and are no longer read by the app-notes UI.
3. Creating an app note makes `<Atelier notes folder>/Untitled note.md` (with
   a non-conflicting suffix when needed). It starts with standard Obsidian
   frontmatter:
   ```md
   ---
   tags:
     - atelier
   atelier_note_id: <stable UUID>
   ---
   ```
4. Atelier lists only Markdown files below the configured notes folder whose
   frontmatter `tags` contains `atelier`; the `archive` subdirectory is never
   listed. Tagged notes created outside Atelier are included too.
5. Editing an app note keeps the existing 600ms autosave and explicit
   `⌘S` behavior, but atomically writes the note Markdown file. The app editor
   receives Markdown without its frontmatter so it never exposes integration
   metadata to the author. As soon as the editor changes, a status beside the
   note title reads **Saving…**; after the atomic file write resolves it reads
   **Synced**. A failed write reads **Save failed** and is never presented as
   synced.
6. Renaming a note atomically renames its Markdown file to the sanitized title
   plus `.md`, retaining its content and frontmatter.
7. Choosing **Delete** opens a confirmation dialog. **Delete** removes the
   `atelier` tag and moves the file into
   `<Atelier notes folder>/archive/`; **Delete permanently** unlinks the file;
   **Cancel** makes no change. A collision in `archive` gets a non-conflicting
   file-name suffix.

## UI

Reuse the existing Vault pane in `Features/UI-Design/mocks/index.html` and the
production Settings panel: add an **Atelier notes folder** input immediately
after `Daily notes folder`, using the existing `.input`, `field-label`, and
`field-hint` treatment. It is vault-relative and defaults to `Atelier`.

Reuse the existing modal/dialog shell and `.btn`, `.btn-primary`, and danger
button treatment. The confirmation has a concise explanation of the archive
operation and three visibly distinct actions: Cancel, Delete, and Delete
permanently.

The app-note sync status reuses the Daily Note topbar treatment exactly:
`.daily-sync-chip`, `.daily-sync-dot`, and `.daily-sync-label`. It sits beside
the app-note title, uses the same **Saving…** and **Synced** labels, and adds
the existing danger token only for **Save failed**. The mock does not include
an app-note editor state, so this placement is defined here.

## Done

- [ ] A configured folder creates tagged Markdown notes; untagged Markdown
      files and archive files do not appear in Atelier.
- [ ] Legacy DB notes export once, then load from their Markdown files after a
      real relaunch.
- [ ] Typing/autosaving and `⌘S` update the source file atomically.
- [ ] App-note edits show Saving… immediately, Synced only after the file write,
      and Save failed when the write rejects.
- [ ] Rename changes the source filename without losing body or frontmatter.
- [ ] Each delete choice has the stated filesystem result.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e:affected` passes.
