# Bug — DevPod Diff rejects `~/…` Git repositories

## Reproduction

Current real session:

- Session `78755d7c-ddc2-4f6f-95db-ae09367f0357` (`dsc-builder`)
- Project path: `~/dsc/dsc-builder/`
- Host: `qingqin-go.devpod-us-or`

The session row and harness are correct: the harness reports cwd
`/home/user/dsc/dsc-builder`, and files load remotely. Diff instead reports
“Not a git repository — nothing to diff”.

The mismatch is concrete and rerunnable:

1. `ssh … -- 'cd "$HOME/dsc/dsc-builder" && git rev-parse
   --is-inside-work-tree'` prints `true`.
2. Atelier’s live Git subprocess instead runs
   `cd '/Users/qingqin/dsc/dsc-builder' && git rev-parse …` on that remote host,
   where the macOS path does not exist.
3. `src/main/panels/git-core.ts` expands `~` through local `homedir()` before
   branching on `sshHost`, then passes the resulting local absolute path to
   `remoteCdTarget`.

## Expected user flow and UI

1. Create or open a DevPod session whose project path is `~` or begins `~/`.
2. Open **Diff**.
3. The app probes Git in the remote user’s home directory and displays the
   Changes view (or “No uncommitted changes”), never the
   `diff-empty-not-repo` state when the remote directory is a repository.
4. Open **Commits** and see the remote repository’s real commit rows.

UI reference: `Features/UI-Design/mocks/index.html`, Diff panel
`.diff-sub-tabs`, `.diff-sub-content`, and `.commit-row`. No visual treatment
changes are needed; this is incorrect data feeding the existing UI.

## Done criteria

- A real Electron/Playwright DevPod test using a `~/…` project path fails on
  the current code, captures the broken state to
  `e2e-artifacts/bug-devpod-diff-tilde-before.png`, and checks `main.log`.
- `runGit` preserves `~` for remote execution so `remoteCdTarget` expands it
  using the remote `$HOME`; local Git still expands `~` using local `homedir()`.
- The exact reproduction passes and captures
  `e2e-artifacts/bug-devpod-diff-tilde-after.png`.
- `npm run build` is clean.
- Category 10 validation from `e2e/TEST_CATEGORIES.md` is run with the
  pre-existing unrelated failures documented if they block the serial suite.

## Validation result

- Exact regression: passes against the real `dsc-builder` DevPod repository;
  the UI shows commit rows and `panel:git:diff:trace` records `isRepo: true`.
- Category 10: 24 tests passed before the serial secondary-panels suite stopped
  on `files panel: devpod pathIsDirectory for tilde-prefixed paths`. Its
  hard-coded remote directory no longer exists (`test -d` returns 1), and the
  test failed identically in two isolated reruns.
- `terminal-pty.spec.ts` also failed identically in two isolated reruns because
  the terminal echo never appeared within 15 seconds. This is the existing
  PTY timing failure and does not exercise Git path resolution.
