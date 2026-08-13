# Session profiles

## User flow

### Create session — Project field (path or profile)

1. User opens **New Session** (`#modal-new-session`).
2. **Project** is a free-text input (`#newSessionProjectInput`, `data-testid="project-path"`) — type any path.
3. On focus or while typing, a dropdown (`.project-picker-menu`) offers recent paths and profiles (filtered by input).
4. Selecting a **profile** fills the input with the profile name (accent styling).
5. Typing again switches back to path mode.

### File directories — relative vs absolute

Each profile stores raw `fileDirectories[]` entries:

| Input | Resolution |
|-------|------------|
| Relative (`src`, `docs`, `./Features`) | Joined to session **workspace root**. When **Use worktree** is checked, joined to the **worktree path** instead. |
| Absolute (`~/…`, `/…`) | Used as-is — unchanged by worktree. |

Terminal, diff, and harness cwd always use the profile workspace (or its worktree when worktree is enabled).

### Manage profiles

1. **Settings** → **Session profiles** — list, add, edit, delete.
2. `#modal-profile-edit` stacks above Settings (`z-index: 60`).
3. Profiles persist in mock `localStorage` (`gardenia-mock-session-profiles`).

### Files tab with profile

1. Profile bar + multi-root tree (`.files-tree-root`).
2. Each root label shows configured dir + resolved absolute path.

### Multi-directory file search (file quick open)

When the active session uses a profile, `#modal-file-quick-open` replaces the single **Dir** row with:

1. **Profile row** — label + profile name (`#fqo-profile-name`).
2. **Scope list** (`#fqo-scope-list`) — one row per search root (workspace + each file directory), showing raw label and resolved path.
3. **All** row at the bottom — search every directory (default).
4. Click a scope to filter; search placeholder updates per scope.
5. **Results** grouped by directory (`.fqo-result-group`); each row: filename + relative path (`.cpsub`).

Single-directory sessions keep the existing **Dir** + recursive search UI.

## Done criteria

- [ ] Spec + mock updated.
- [ ] App: resolve relative dirs against workspace or worktree; absolute unchanged.
- [ ] New Session Project picker lists profiles immediately after create (no stale menu).
- [ ] Settings CRUD + Files multi-root + quick open.
- [ ] Targeted e2e + clean build.
