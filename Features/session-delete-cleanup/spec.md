# Session deletion cleanup

## User flow

1. The user chooses **Delete** from a session row.
2. The selected session is immediately deselected and its chat/workspace
   surface is evicted.
3. The session row remains in its existing sidebar section while cleanup is
   running. The row is dimmed, cannot be selected, dragged, or opened, and
   shows **Cleaning up session…**.
4. Atelier interrupts the harness and removes session-owned artifacts:
   persisted chat/history rows, the Claude Code JSONL/session directory and
   `~/.claude/session-env/<id>` files, PTY/port/workspace state, and the git
   worktree/branch.
5. A worktree is shared by Fork/Restart copies. Atelier removes it only when
   no non-deleting session still references the same `worktree_path`.
6. Once every required cleanup step succeeds, Atelier removes the session
   row from SQLite and the sidebar.
7. If the app exits during cleanup, the persisted `deleted_at` marker keeps
   the disabled row visible on the next launch and cleanup resumes
   automatically.

## UI

The existing mock does not cover asynchronous deletion. Add the state to
`Features/UI-Design/mocks/index.html` and reuse the established
`.session-row[data-status="creating-worktree"]` treatment:

- `.session-row[data-status="cleaning-up"]` uses the same disabled,
  `opacity: .5`, non-interactive row treatment.
- `.session-creating-label` is reused for the tertiary 11.5px status text,
  displaying **Cleaning up session…**.
- The existing `.session-status` glyph system is reused with a faint,
  spinning dashed-circle indicator; no new color token is introduced.
- The row has no menu, reconnect, pin, spend, or drag affordance while
  cleanup is running.

## Done / validation

- Deleting a real session first persists `deleted_at` and leaves a disabled
  sidebar row showing **Cleaning up session…**.
- The row disappears only after its messages, FTS entries, Claude session
  files, and unshared worktree have been removed.
- Deleting one fork does not remove a worktree still referenced by another
  session.
- Pending cleanup survives relaunch and resumes.
- Main-process logs contain cleanup started/completed events and failures
  retain the row instead of silently reporting success.
- `npm run build` passes.
- Category 2 targeted e2e files from `e2e/TEST_CATEGORIES.md` pass.
- The changed cleanup-state screenshot is viewed and compared with
  `Features/UI-Design/mocks/index.html`.
