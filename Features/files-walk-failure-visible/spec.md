# Files panel: a failed walk must not look like an empty workspace

## Bug

Session `vibe dashboard` (remote devpod, worktree root) showed an empty Files
tab and could not open any file, for the whole life of the session.

Root cause chain, from `main.log`:

1. SSH to the devpod was down for ~10s exactly while the session opened
   (`files:tree:remote:done code=255`, `Claude Code process exited with code
   255`, `remote tmux not available`).
2. `walkRemote()` ignored the non-zero ssh exit code and returned
   `buildRemoteTree(root, '')` — an **empty tree**, indistinguishable from a
   genuinely empty directory.
3. That empty result was cached in the session workspace snapshot
   (`session:openReady … "treeEntries":0`).
4. Poll refreshes never re-walk files (`includeFiles` defaults to false, so
   they carry `prev.filesTree` forward). The one `includeFiles: true` refresh
   happens once, right after worktree creation — which is the call that landed
   inside the outage.
5. `FilesPanel` skips its own `filesTree` fetch whenever `initialFilesTree` is
   non-null, and `[]` is non-null — so it rendered an empty tree forever, with
   no error and no way to retry.

The same window also cached an empty `filesList`, which silently broke
`@`-mention file search and reveal-in-Files for that session.

The local walk has the same shape of bug: if the workspace root itself is
unreadable or missing, `walkLocalDir()` catches the error and returns `[]`.

## Expected behaviour

**Failure must be distinguishable from emptiness, at every layer.**

1. `walkFileTree` / `walkDirChildren` / `listWorkspaceFiles` **throw** when the
   walk could not be performed:
   - remote: ssh exited non-zero (255 connection failure, or a failed `cd`);
   - local: the starting directory is missing or unreadable.
   An empty-but-readable directory still returns `[]`.
   Individual unreadable *children* are still skipped, not fatal.
2. The workspace snapshot stores `filesTree: null` / `filesList: null` for
   "not known" instead of `[]`. A files failure must not discard the rest of
   the payload (diff, cap, terminal) — chat and diff keep working.
3. A refresh that does not re-walk files carries the previous value forward
   **including** `null`, so a failed walk never hardens into a fake empty.
4. `FilesPanel` treats `null` as "go fetch" (existing behaviour) and, when its
   own fetch fails, shows an error row with a **Retry** button instead of an
   empty tree. There is also an always-available **Refresh** control in the
   panel header, so a stale tree can be re-walked without reopening the
   session.

## Expected user flow

1. User opens the Files tab of a session whose workspace root cannot be walked
   (devpod asleep / SSH down / directory deleted).
2. Instead of a blank tree, the panel says the files could not be loaded and
   offers **Retry**.
3. When the host/directory comes back, clicking **Retry** (or **Refresh**)
   loads the real tree; no session reopen needed.

## UI

No new visual language: reuse the existing panel-empty/notice treatment from
`Features/UI-Design/mocks/index.html` (`.files-empty` copy style) plus the
existing small icon-button styling used by other panel header controls
(`.panel-head` / `.icon-btn`). Error copy is secondary text; the Retry control
is an `.icon-btn`-styled inline button.

## Reproduction (must fail before the fix)

`e2e/bug-files-walk-failure-visible.spec.ts`:

1. **Real ssh failure (no mocks):** `window.atelier.filesTree('/tmp',
   '<unreachable-host>')` — a real `ssh` call that really exits 255.
   Before: resolves `[]`. After: rejects.
   Same for `filesList`.
2. **Missing local root:** `window.atelier.filesTree('<deleted dir>')`.
   Before: resolves `[]`. After: rejects.
3. **Panel UI:** a session whose project directory is deleted shows the
   Files error + Retry; restoring the directory and clicking Retry renders
   the real tree.
4. **Log evidence:** `main.log` contains `files:tree:failed` /
   `files:tree:remote:failed` with the exit code.
5. **Screenshot:** `e2e-artifacts/07-files-walk-failed-retry.png`.

## Done criteria

- [ ] `npm run build` clean.
- [ ] `npm run test:e2e:affected -- --base main` green (minus the known
      pre-existing `audit-scroll-experience` daily-notes failure).
- [ ] The new spec fails on `main` and passes after the fix.
- [ ] Screenshot artifact viewed and compared against the mock.
