# Todo ↔ session link (Obsidian daily notes)

## User flow

1. User right-clicks a timeline or unscheduled task → context menu shows **Create session** (alongside Rename / Move to…).
2. If the task already has `[session:: …]` linked, show **one** confirmation dialog, then open New Session; the new session replaces the link on successful create.
3. New Session modal opens (`#modal-new-session` / `data-testid="new-session-modal"`). On successful create:
   - Task line gains `[session:: <session-id>]` in the vault note.
   - Session row stores `linked_daily_task_gid` + `linked_daily_note_date` in SQLite.
   - App selects the new session.
4. User **deletes** a linked session from the sidebar → modal (**Direction B** choice list) lets them pick **complete task and delete session** or **delete session only**, then **Delete** (Cancel aborts). Close does not show this prompt.

## UI

- Context menu: reuse `.dn-move-menu-popup` / `.smi` from `TaskMoveContextMenu.tsx` (same as 16-task-move-to-date).
- Replace / delete confirmations: `.modal-dialog.confirm-dialog` — **authoritative mock:** `Features/UI-Design/mocks/todo-session-link-dialogs.html` (vault) with classes in `shared.css`. Replace: single step. Delete: **Direction B** choice list (`.confirm-choice-list`); Direction A stacked footer remains in mock as alternative.

## Done criteria

- Targeted e2e: `obsidian-integration.spec.ts` (create + link + file field + DB), `session-lifecycle.spec.ts` (close prompt + optional complete).
- `npm run build` clean.
