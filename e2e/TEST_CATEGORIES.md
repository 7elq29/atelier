# E2E Test Categories

Human-readable ownership and coverage reference. Executable affected-test
selection lives in `e2e/test-impact-map.json` and
`scripts/e2e-affected.mjs`; categories are intentionally broader and should
not be expanded into a test command.

## How to use this

1. Inspect the affected targets and their selection reasons:
   ```bash
   npm run test:e2e:affected:list
   ```
2. Run exactly those targets:
   ```bash
   npm run test:e2e:affected
   ```
   For a committed range use
   `npm run test:e2e:affected -- --base <ref> [--head <ref>]`.
3. Selection is component/file-specific. Shared files such as `global.css`
   and `App.tsx` use per-hunk rules for recognizable surfaces; any unowned
   hunk also adds the broader fallback. A changed spec always selects itself.
4. An unmapped `src/**` file is an error, not permission to skip tests. Add a
   narrow ownership rule to `e2e/test-impact-map.json`.
5. The categories below remain useful for understanding feature boundaries,
   auditing the impact map, and deciding when an intentional broad regression
   run is warranted. They are not the default command.

---

## Categories

### 1. App Shell & Bootstrapping

| | |
|---|---|
| **Spec files** | `app-shell.spec.ts` |
| **Source paths** | `src/main/index.ts`, `src/main/logger.ts`, `src/main/config.ts`, `src/renderer/src/styles/*` (shared.css tokens), preload bridge (`window.atelier`) |
| **Catches** | Window title/launch, `#root` mounting, the `app:getVersion` IPC round-trip, main-process log file creation (`app ready`, IPC entries), and that the shell renders real design tokens instead of Electron/browser defaults. |

### 2. Session Lifecycle (New Session, Modes, Resume/Fork/Rename/Delete)

| | |
|---|---|
| **Spec files** | `session-lifecycle.spec.ts`, `session-ready-hint.spec.ts`, `composer-mode-indicator.spec.ts`, `bug-new-session-path-history.spec.ts`, `packaged-app-local-tilde.spec.ts`, `bug-slash-model-command-missing.spec.ts` (setup path only), `secondary-panels.spec.ts` (terminal-only session setup) |
| **Source paths** | `src/renderer/src/components/NewSessionModal.tsx`, `src/renderer/src/components/SessionDisconnectedPanel.tsx`, `src/renderer/src/components/chat/SessionReadyHint.tsx`, `src/main/sessions/manager.ts`, `src/main/sessions/hosts.ts`, `src/main/sessions/ipc.ts`, `src/main/sessions/store.ts`, `src/main/harness/*` |
| **Catches** | New Session Modal flows (claude-code vs terminal mode, project-folder picker, remote path history/host options), session menu actions (rename/fork/restart/delete), resume of a prior session, terminal-only sessions. Use-worktree: modal closes immediately when "Use worktree" is checked, sidebar row shows `creating-worktree` state (dimmed, "Setting up worktree…" label), transitions to live status on success; on failure the row stays with a system error (no silent delete); the harness also appends a worktree-boundary block to the `claude_code` preset system prompt (`src/shared/worktree-prompt.ts`) naming the worktree and the original checkout, so a real turn's edits stay inside the worktree instead of landing in the original repo where the Diff panel can't see them. Ready-to-chat hint: a new session is held by the connecting gate (no tab strip), then the empty transcript shows a "Ready to chat" hint and focuses the composer instead of leaving a blank pane, and a session that finishes connecting while the user is on another session announces itself with a transient toast. |

### 3. Session Organization (Sidebar, Groups, Search, Filters, Tags)

| | |
|---|---|
| **Spec files** | `session-organization.spec.ts`, `weekly-plan-wizard.spec.ts`, `sidebar-refinement.spec.ts` |
| **Source paths** | `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/panels/AppNotesPanel.tsx`, `src/renderer/src/components/panels/DailyNoteEditorPanel.tsx`, `src/renderer/src/components/panels/WeeklyPlanWizardPanel.tsx`, `src/main/weekly-note-io.ts`, `src/main/weekly-notes-handlers.ts`, `src/renderer/src/hooks/useDailyNoteNotesSlice.ts`, session store/manager (`src/main/sessions/store.ts`, `manager.ts`), `src/main/app-notes/*`, `src/main/app-bookmarks/*`, `src/renderer/src/components/BookmarkEditModal.tsx`, `src/renderer/src/hooks/useAppBookmarks.ts` |
| **Catches** | Sidebar search, status filters (all/attention/waiting), session groups (create/rename/drag), session detail popover (notes, tags, color swatch), single-selection highlighting (focusing the daily note or an app note clears the session row's selected background, and reselecting the session restores it), command palette entry point from the sidebar, compact single-line Daily note and Weekly plan rows, stable terminal identity glyphs instead of agent waiting status, sidebar-only typography tuning, weekly plan guided wizard creating `02.weeklynotes/YYYY-Wnn.md`, sidebar Bookmarks pane (add/edit/remove, bare-URL rows, click-opens-external, drag a chat link onto the pane). |

### 4. Chat Transcript & Composer Core

| | |
|---|---|
| **Spec files** | `chat-surface-core.spec.ts`, `bug-bookmark-file-right-panel.spec.ts`, `composer-core.spec.ts`, `harness-sdk-events.spec.ts`, `chat-transcript-window.spec.ts` |
| **Source paths** | `src/main/harness/*`, `src/main/sessions/manager.ts`, `src/main/sessions/session-harness-ui.ts`, `src/main/sessions/store.ts`, `src/shared/chat-transcript-window.ts`, `src/shared/review-pane-types.ts`, `src/renderer/src/components/chat/*`, `src/renderer/src/App.tsx` (chat bookmark/review handlers), `src/shared/harness-ui-types.ts`, `Features/harness-sdk-events/spec.md`, `Features/chat-transcript-window/spec.md` |
| **Catches** | Sending a real message end-to-end, live todo-tracker updates from a real `TodoWrite` SDK call, transcript message rendering, chat transcript display window (last 40 user-turn conversations + truncation banner), composer send/stop-button behavior mid-stream, Markdown rendering of assistant text (bold/inline-code/fenced-code-blocks/lists/links via `MarkdownMessage.tsx`, with user messages and search-highlighting explicitly excluded from Markdown rendering), standalone bookmarked files opening in Chat's right-hand review panel rather than replacing Chat with Files, tool-call sequence collapsing into one expandable aggregate summary row (mid-turn aggregate+current-card, post-turn single-aggregate, expand/click behavior, single-tool-call no-aggregation, edit-vs-other collapsed-row content, subagent-nested sequence aggregation). SDK harness event UI (`harness-sdk-events.spec.ts` + `e2e/HARNESS_SDK_EVENTS_BUG_BASH.md`): composer turn hint, no REQUEST transcript card, tool elapsed, background jobs only in the tracker rail (no transcript “Background tasks” card), toast negatives. |

### 5. Composer Mentions, Slash Commands & Model Picker

| | |
|---|---|
| **Spec files** | `composer-mentions-and-commands.spec.ts`, `bug-slash-model-command-missing.spec.ts`, `bug-model-picker-option-list.spec.ts`, `model-effort-picker.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/Composer.tsx` (mention/slash popovers, `/model` interception), model-picker/effort-picker UI inside `Composer.tsx` |
| **Catches** | `@file` mention popover + selection, `/` slash-command popover, that `/model` is intercepted locally (never sent as literal chat text) and opens the Model Picker, that the picker's catalog is accurate (no stale/invented model ids, fable/mythos present), and the effort (low/medium/high) sub-picker. |

### 6. Interactive Prompts (Permissions, Plan Mode, Ask-User-Question)

| | |
|---|---|
| **Spec files** | `interactive-prompts.spec.ts`, `bug-ask-user-question-explicit-submit.spec.ts`, `bug-plan-card-expired-prompt.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/PermissionRequestCard.tsx`, `src/renderer/src/components/chat/PlanProposedCard.tsx`, `src/renderer/src/components/chat/AskUserQuestionCard.tsx`, `src/renderer/src/components/chat/TranscriptInlineComments.tsx`, `src/main/harness/claude-agent-sdk-harness.ts`, `src/main/sessions/manager.ts`, `src/renderer/src/components/chat/MarkdownMessage.tsx` |
| **Catches** | Real permission-request round-trips (allow/always-allow/deny), plan-mode proposal accept/reject, `AskUserQuestion` card option selection requiring an explicit submit click (not an instant single-click submit), plan-card markdown rendering, inline select-to-comment on plan bodies in the transcript, and cards correctly showing an "expired" state (no dead action buttons) when a turn ends in error while a prompt is still pending. |

### 7. Message Actions (Copy / Speak)

| | |
|---|---|
| **Spec files** | `message-actions.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/MessageActions.tsx`, `src/renderer/src/components/chat/TranscriptInlineComments.tsx`, `src/renderer/src/components/chat/ChatTranscript.tsx` |
| **Catches** | Per-message copy button and text-to-speech (speak) button + speaking indicator; inline select-to-comment on assistant responses in the transcript. |

### 8. Enrichment Features (10a-10g)

| | |
|---|---|
| **Spec files** | `enrichment-cost-tracking.spec.ts` (10a), `session-cost-tracking.spec.ts`, `bug-session-cost-historical-backfill.spec.ts`, `enrichment-full-text-search.spec.ts` (10b), `enrichment-export-conversation.spec.ts` (10c), `message-actions.spec.ts` (10d), `composer-mentions-and-commands.spec.ts` (10e), `model-effort-picker.spec.ts` (10f), `enrichment-image-attachment.spec.ts` (10g) |
| **Source paths** | `src/renderer/src/components/chat/ChatTranscript.tsx`, `TranscriptSearchBar.tsx`, `ExportMenu.tsx`, `MessageActions.tsx`, `Composer.tsx`; `src/main/sessions/export-format.ts` |
| **Catches** | Cost chip accuracy, transcript full-text search bar + match navigation, JSON/Markdown conversation export, message copy/speak, file mentions & slash commands, model/effort pickers, and image attachment (attach/thumbnail/remove in composer, render in transcript). Grouped here because these were built as a numbered enrichment series (10a-10g); see category 4-7 for the more general components each touches. |

### 9. Global Nav, Command Palette & Settings

| | |
|---|---|
| **Spec files** | `global-nav-and-settings.spec.ts`, `bug-keyboard-hint-labels.spec.ts` |
| **Source paths** | `src/renderer/src/components/CommandPalette.tsx`, `src/renderer/src/components/SettingsPanel.tsx`, `src/renderer/src/components/Sidebar.tsx` (collapsed rail mode), `src/renderer/src/components/OnboardingWizard.tsx`, `src/renderer/src/components/KeyboardHintsOverlay.tsx`, `src/renderer/src/keyboard-hints/*` |
| **Catches** | Command palette open/search/empty-state, collapsed sidebar rail toggle, Settings panel (theme light/dark, independent font-size sliders for interface/agent-message/terminal), desktop notification debug trigger, first-run onboarding wizard (shown once, name/email steps). ⌘-hold keyboard hints: label allocation stays unique, prefix-free and single-keystroke for as many targets as the alphabet allows, the live overlay paints distinguishable badges, and a single-digit row label (⌘+1) still activates on ⌘ release once a "1x" row makes it ambiguous. |

### 10. Secondary Panels (Diff, Files, Ports, Terminal, Worktrees)

| | |
|---|---|
| **Spec files** | `secondary-panels.spec.ts`, `terminal-pty.spec.ts`, `bug-diff-preload-limit.spec.ts`, `bug-diff-refreshing-stuck-on-timeout.spec.ts`, `diff-session-compare-trace.spec.ts`, `bug-workspace-buffer-lost-on-view-switch.spec.ts`, `bug-files-walk-failure-visible.spec.ts`, `bug-terminal-blocks-daily-note.spec.ts`, `session-tab-memory.spec.ts` |
| **Source paths** | `src/renderer/src/components/panels/*` (`DiffPanel.tsx`, `FilesPanel.tsx`, `PortsPanel.tsx`, `TerminalPanel.tsx`, `TabBar.tsx`), `src/main/panels/*` (`git.ts`, `git-repository.ts`, `files.ts`, `editor-buffers.ts`, `ports.ts`, `pty.ts`, `ipc.ts`), `src/main/sessions/workspace-service.ts` |
| **Catches** | Tab strip switching (chat/diff/files/ports), git diff sub-tabs (changes/commits/worktrees) including worktree add/merge/remove and diff inline comments, background preload hydrating at most 10 changed-file patches while keeping the full list and lazy-loading later files on click, file tree browsing + content/image/HTML preview, ⌘-hold hint badges on Files-tree directories and files (activate opens/toggles), unsaved Files-editor edits surviving navigation via `<userData>/editor-buffers` scratch files (restored on re-open, written to the real file only on ⌘S, purged on app restart), port forwarding rows (add/remove/status), real PTY-backed terminal panel. A files walk that could not run (real ssh exit 255, missing local root) surfaces an error row with Retry instead of an empty tree, and is cached as `filesTree: null` rather than `[]` so one SSH blip cannot pin a session's Files tab empty for its whole life. The session Terminal tab (and terminal-only main view) has no in-panel title/cwd/host bar — xterm fills the pane with the toolbox toggle overlaid, matching the mock; the companion drawer still has its header + close. Per-session tab memory: each session reopens on the tab it was left on after a session switch and after a real relaunch, with the value persisted in the `sessions.active_tab` column rather than only in renderer state. SSH ControlMaster: verifies that opening a devpod terminal creates a `/tmp/atelier-ssh-*` multiplexing socket (proving `SSH_MUX_OPTS` are applied so subsequent SSH calls reuse the socket instead of doing a full crypto handshake). Terminal pane fit: the `.xterm` box stays inside `.term-body`'s content box at a range of window heights, so the bottom line is never sliced in half — the 4px inset lives on `.xterm` (which FitAddon subtracts) rather than on `.term-body` (whose border-box height FitAddon reads as usable space). Wheel scrolling scrolls the terminal: because terminals are tmux clients in xterm's alt buffer, the wheel used to be translated into ESC[A/ESC[B and walk zsh history — spawning now turns on the tmux session's `mouse` option, so wheel-up scrolls the pane's scrollback (copy-mode) and scrolling back to the bottom leaves copy-mode with the shell still accepting input. |

### 11. Daily Notes & Obsidian Sync

| | |
|---|---|
| **Spec files** | `obsidian-integration.spec.ts`, `bug-57-obsidian-external-edit-timeline-sync.spec.ts`, `bug-daily-note-template.spec.ts`, `bug-daily-notes-time-editing.spec.ts`, `bug-note-content-survives-immediate-edit.spec.ts`, `task-move-to-date.spec.ts`, `bug-move-task-not-found-in-source-note.spec.ts`, `bug-move-task-not-found-gidless-task.spec.ts`, `todo-session-link.spec.ts`, `daily-note-notes-editor.spec.ts`, `daily-big-three-edit.spec.ts` |
| **Source paths** | `src/renderer/src/components/daily-notes/*` (`Timeline.tsx`, `DailyNotesSidebar.tsx`, `TaskItem.tsx`, `TaskMoveContextMenu.tsx`, `move-date-options.ts`, `CurrentTimeLine.tsx`, `section-resize.ts`, `timeline-scale.ts`, `TaskSessionLinkDialogs.tsx`), `src/renderer/src/components/panels/DailyNoteEditorPanel.tsx`, `src/renderer/src/hooks/useDailyNote.ts`, `src/renderer/src/hooks/useDailyNoteNotesSlice.ts`, `src/main/daily-note-io.ts`, `src/main/daily-notes-handlers.ts`, `src/main/daily-note-session-link.ts`, `src/main/sessions/store.ts`, `src/main/sessions/manager.ts`, `src/main/sessions/ipc.ts`, `src/renderer/src/App.tsx` |
| **Catches** | Parsing/rendering of real vault markdown fixtures into Timeline/Backlog/Delegated/Unscheduled, editing and persisting the daily Big Three from the Today’s Focus block, external-edit file-watch propagation (bug #57's parser mis-classification of moved tasks), vault-template-based daily note creation, right-click-to-create + edit tasks in the timeline, absolute-grid interactions (54a rewrite), list-management affordances (add-task/edit/tags/Big Three/collapse/close), current-time marker placement, section resize/carry-over on note creation, right-click "Move to..." context menu on Timeline/Unscheduled tasks and the cross-file move to another date's Backlog section — including target-note creation from the template and appending into an already-existing Backlog section (16-task-move-to-date, `task-move-to-date.spec.ts`). Daily note compact header: title, smaller date label with previous/next arrows, and quiet dot-based sync state share the main topbar; there is no second editor toolbar or Today button. |

### 12. UI Chrome Bug Fixes (small, targeted repros)

| | |
|---|---|
| **Spec files** | `bug-remove-version-corner.spec.ts`, `bug-tracker-rail-width.spec.ts`, `bug-tracker-rail-collapse-toggle.spec.ts` |
| **Source paths** | `src/renderer/src/styles/global.css`, `src/renderer/src/components/chat/TrackerRail.tsx` |
| **Catches** | No permanent "debug corner"/version badge present in the empty state; TrackerRail's computed width matches the authoritative mock (`Features/UI-Design/mocks/design-variants/variant-1-soft-paper.html`) rather than a stale value. |

### 13. Window Resize / Layout Audits

| | |
|---|---|
| **Spec files** | `audit-window-resize-layout.spec.ts`, `audit-scroll-experience.spec.ts` |
| **Source paths** | Cross-cutting: `src/renderer/src/styles/global.css`, `.app-body` top-level panel layout, `src/renderer/src/components/chat/*`, `src/renderer/src/components/daily-notes/*`, `src/renderer/src/components/NewSessionModal.tsx` |
| **Catches** | Real `BrowserWindow` resize across 5 sizes x 4 app states, checking for sibling-panel overlap and unintended content-hiding overflow (excluding intentionally-scrollable containers); real scroll behavior in transcript/sidebar/tracker/daily-notes bodies (not just overflow metrics) via mention popover, timeline task, and tracker-task interactions while scrolled; that `.composer-wrap` spans the full width of `.chat-body-row` beneath BOTH the transcript column and the Tracker Rail (not nested inside `.chat-main-col`), with identical width whether the Tracker Rail is visible or absent, and strictly wider than `.chat-main-col` when the rail is visible. Since 15-conversation-scrollbar-outer-edge: `.chat-body-row` (not `.transcript`) is the single scroll container for the transcript + Tracker Rail, so the native scrollbar renders at the true outer-right window edge past the rail — `audit-scroll-experience.spec.ts` asserts `.transcript` no longer has `overflow-y: auto`, that `.chat-body-row` does and drives real auto-scroll-to-bottom, and that `.tracker-rail` (pinned via `position: sticky; top: 0`) stays visible on screen while the transcript scrolls past it and has no scrollbar of its own even though its per-card `.tracker-body` still scrolls internally. These are cross-cutting regression nets, not single-feature specs — expect to run them whenever touching shared layout/CSS, even if your change is "in" another category. |

---

## Notes on scope overlap

Nearly every spec launches through the same New Session Modal boilerplate
(`new-session-button` -> `new-session-modal` -> `project-path` ->
`mode-claude-code`/`mode-terminal` -> `initial-prompt` -> `start-session-button`),
so a regression in `NewSessionModal.tsx` or `src/main/sessions/*` can show up
as failures across nearly all categories above, not just category 2. If
you're touching session-creation/bootstrap code, run category 2 plus at
least a couple of other categories whose specs rely on that same setup path
(e.g. category 4 and category 6) to get a wider signal — still targeted,
not the full suite.
