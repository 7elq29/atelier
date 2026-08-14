# Session project path update

## User flow

1. Open a session row menu → **Details**.
2. Edit **Project path** (mono input, same styling as New Session modal path field).
3. Click **Apply** — path persists; diff, files, terminal cwd, and workspace preload reload for the new directory.

## UI

- Reuse `.input`, `.project-path-input`, `.sdp-section` / `.sdp-label` from `Features/UI-Design/mocks/shared.css` inside `session-detail-popover`.
- `data-testid="session-project-path"`, `data-testid="apply-project-path-button"`.

## Done criteria

- [ ] `session:setProjectPath` updates SQLite `sessions.project_path`, clears stale `worktree_path`, records path history.
- [ ] Claude-code sessions: workspace evicted + re-preloaded (`session:openReady`); git cache invalidated.
- [ ] Renderer kills tab/companion PTYs and remounts panels/terminals against the new cwd.
- [ ] Targeted e2e in `secondary-panels.spec.ts`: change path → DB + diff panel + terminal cwd reflect new path.
