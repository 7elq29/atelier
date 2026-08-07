# Session workspace preload

## User flow

1. User creates, resumes, or reconnects a claude-code session (local or devpod).
2. Main area for **that session** shows **Connecting…** until harness + workspace preload finish (git summary, files tree/list, tab-terminal PTY).
3. User may switch to other sessions or use global UI during connect; only the opening session’s content is gated.
4. On **`session:openReady`**, Chat/Diff/Files/Terminal for that session are hydrated; tab switches are visibility-only (Diff→Changes also triggers immediate async refresh in main).
5. While session is live, main refreshes git in the background (local: watch `.git/index`; devpod: **15s** poll) and pushes **`session:workspaceUpdated`**.

## Done criteria

- `preloadSessionWorkspace` awaited in main before `session:openReady` (not fire-and-forget).
- Devpod uses same APIs with `hostname`; poll interval **15s**.
- Chat cap and Diff Changes read preloaded data; no renderer poll interval; Diff Changes requests immediate refresh on open.
- Targeted e2e: `secondary-panels.spec.ts`, `composer-core.spec.ts`; `npm run build` clean.
