# File quick open (Ctrl+X Ctrl+F)

## User flow

1. User focuses the app shell (any tab) with an active **claude-code** session.
2. User presses **Ctrl+X**, then **Ctrl+F** within ~1.5s (Emacs-style find-file chord).
3. A modal palette opens (same `cp-dialog` chrome as ⌘K) with **two areas separated by a rule**:
   - **Directory** — session workspace root by default (`worktreePath ?? projectPath`); click or Backspace from an empty search field to edit.
   - **Search** — recursive file search **under the current directory**.
4. **Directory mode**: list shows **only immediate children** (files and folders) of the current directory; filter names by **case-insensitive substring**; **Backspace** on an empty dir field moves up one level (not above session root); **Tab** completes the highlighted match in the path (when filtering by a name fragment), **Tab** again commits the path and focuses **Search**; **Enter** on a folder descends and focuses **Search**; Enter on a file opens it.
5. **Search mode**: recursive listing under the **Dir** folder (`currentDir`); **substring** filter on file name, path relative to that folder, or absolute path (slashes are literal text, not path navigation). Enter opens in Files tab.
6. **Escape** or backdrop click closes without opening.

Unavailable when there is no active session or the session is not `claude-code`.

## UI

- `fqo-head`, `fqo-dir-row`, `fqo-sep`, `fqo-search-row`, `fqo-hint` in `Features/UI-Design/mocks/index.html` and `global.css` (extends command-palette tokens).

## Done criteria

- Split dir/search UI; dir mode one level; search recursive under current dir; Tab completes folder (e2e in `secondary-panels.spec.ts`).
- Mock section in `Features/UI-Design/mocks/index.html` demonstrates both modes interactively.
- `npm run build` clean; targeted e2e pass.
