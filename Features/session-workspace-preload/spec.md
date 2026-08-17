# Session workspace preload

## User flow

1. User creates, resumes, or reconnects a claude-code session (local or devpod).
2. Main area for **that session** shows **Connecting…** only while **essential** workspace preload runs: SSH warm (devpod), files tree/list, tab-terminal PTY, and a **fast git repo probe** (rev-parse + branch — no full numstat/`ls-files` scan). Full git diff + changes cap load **in the background after** panels unlock.
3. User may switch to other sessions or use global UI during connect; only the opening session’s content is gated. **Preload on one session must not block unrelated sessions or global app operations** — remote preloads on the same devpod host are queued (one at a time per host).
4. On **`session:openReady`**, Chat/Diff/Files/Terminal for that session are hydrated immediately with essential data. Diff shows tracked changes from background git quickly; **`git ls-files --others`** runs non-blocking and merges untracked paths when ready. Tab switches are visibility-only (no forced full git rescan on Diff open).
5. While session is live, main refreshes git in the background (local: watch `.git/index`; devpod: **15s** poll) and pushes **`session:workspaceUpdated`**.
6. If connect takes longer than a few seconds, the connecting gate shows **which essential step** is running (SSH, files, terminal, git probe). Main logs **`session:openTiming`** with per-step ms for essential and background phases.

## Done criteria

- Essential preload awaited before `session:openReady`; full git diff + cap deferred to background (must not block `connecting`).
- `session:openTiming` logged with `essentialMs`, optional `sshWarmMs`/`filesTreeMs`/`filesListMs`/`ptyMs`/`gitProbeMs`, and later `backgroundGitMs`/`backgroundCapMs` when background preload completes.
- Session stays in `connecting` until essential preload completes (or times out to best-effort empty workspace + background refresh).
- Remote devpod preloads on the same `hostname` run through a per-host queue; `startupReconnect` staggers harness starts per host.
- Background git/cap refresh on the same `hostname` is serialized (`withRemoteBackgroundHostQueue`); non-interactive SSH exec is capped at **6 concurrent per host** (`SSH_MAX_CONCURRENT_EXEC_PER_HOST` in `ssh-exec.ts`).
- Devpod uses same APIs with `hostname`; poll interval **15s**.
- Chat/Diff/Files/Terminal visible immediately after openReady; Diff does not force-refresh on tab open when preloaded data exists.
- Targeted e2e: clones the **exact** AI conformance session (`b986cbd0…`, 451+ messages) from the developer's production `atelier.sqlite` into an isolated userData dir (`session-lifecycle.spec.ts`), plus `secondary-panels.spec.ts`, `composer-core.spec.ts`; `npm run build` clean.
