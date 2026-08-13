# Configurable worktree root

## User flow

1. User enables **Use worktree** in New Session; worktree is created at `<worktreeRoot>/<session-id>` (default `~/.atelier/worktrees/<session-id>`), not under the project repo. Creation has **no timeout** — large remote repos may take many minutes.
2. User changes **Worktree directory** in Settings → Agent; new sessions use the updated root (existing sessions keep their stored `worktree_path`).
3. Closing a session removes its git worktree and branch and clears `worktree_path`. Deleting a closed session also cleans up if any worktree remained.

## UI

- Settings → Agent: text field **Worktree directory** (monospace), default `~/.atelier/worktrees`.
- Settings → **Sessions**: **Default worktree location** with dedicated Save (persists `worktreeRoot` in config).
- New Session checkbox hint: `— isolated copy at <worktreeRoot>/<id>` from config.

## Done

- `npm run build` clean.
- `e2e/session-lifecycle.spec.ts` use-worktree tests still pass (paths contain `.atelier/worktrees`).
