# New Session modal redesign (agent modes only)

## User flow

1. Click New Session (sidebar `+` or command palette).
2. Modal opens with three **agent** mode types in a left rail: Claude Code
   (default), Cortana, Minion. There is no Terminal mode in this modal —
   terminals are created via the sidebar local-terminal control, ⌘ palette
   “New Terminal”, or companion Terminal on an agent session.
3. For Claude Code: pick Project + Host, optional worktree toggle → Start
   Session, then chat from the composer.
4. For Cortana: Start Session (no fields), then chat from the composer.
5. For Minion: Repository + optional attach link + task prompt (required for
   create; not required when attaching) → Start / Attach Session.
6. Cancel closes without creating.

## Expected UI

Pattern: **type rail + conditional panel** (JetBrains New Project Wizard /
NN-G progressive disclosure) — not a flat stack of equal cards.

- Left rail: Claude Code / Cortana / Minion (neutral selected: `bg-active` +
  left bar; **no accent/green**).
- Right panel swaps by type:
  - Claude: Project, Host, worktree toggle (always visible). No initial prompt.
  - Cortana: no fields — start and chat from the composer. No initial prompt.
  - Minion: **Repository**, **Attach existing task**, **Task prompt**
    (required for create; not required when attaching).
- Primary CTA is inverted (`text-primary` on `bg-panel`), not green.
- Terminal is not in this modal.

Mock: `Features/UI-Design/mocks/index.html` `#modal-new-session`.

## Done criteria

- [x] Terminal absent from New Session modal (UI + mock); Terminal mode still
      creatable via sidebar / palette / IPC.
- [x] Type rail + conditional panels; Minion keeps repo / attach / task prompt.
- [x] No Claude/Cortana initial prompt; no green selection chrome.
- [x] Outdated e2es that created Terminal via `mode-terminal` in the modal
      removed (not rewritten via IPC helpers).
- [x] Claude first messages in lifecycle e2es go through the composer.
- [x] Screenshot `e2e-artifacts/new-session-modal-redesign.png` reviewed
      (type rail, no Terminal, inverted Start, worktree visible).
- [x] Validate with `npm run test:e2e:new-session-modal` (narrow targets,
      `--workers=1`) — **not** full `test:e2e:affected` after deleting
      outdated mode-terminal specs (that expands the selector into large
      suites and flake loops).
