# E2E Test Categories

Fast-feedback map from "area of the codebase I'm touching" to "which spec
files exercise it," so you don't have to run the full suite (or guess) while
iterating.

## How to use this

1. Find the category below whose **source paths** overlap the files you're
   changing.
2. Run just that category's specs for a fast local signal, e.g.:
   ```bash
   npx playwright test e2e/composer-core.spec.ts e2e/composer-mentions-and-commands.spec.ts
   ```
3. **This is the validation step itself, not just a speed aid.** Per
   `CLAUDE.md` §3, a change is validated by running every spec file in the
   matched categor(ies) — including ones you didn't add — not by running the
   full suite. Category runs catch regressions in the area you touched; they
   do not catch cross-feature state bleed (shared sidebar/session state,
   global CSS, IPC plumbing shared across features) the way a full run would,
   but CLAUDE.md deliberately accepts that tradeoff for faster iteration —
   don't run the full suite as a default "just to be safe."
4. If a spec touches multiple areas (several do — most launch through the
   same New Session Modal / Composer flow as setup), it's listed under every
   category it meaningfully covers, not just its "primary" one. When your
   change overlaps several categories, run all of them together.

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
| **Spec files** | `session-lifecycle.spec.ts`, `bug-new-session-path-history.spec.ts`, `bug-slash-model-command-missing.spec.ts` (setup path only), `secondary-panels.spec.ts` (terminal-only session setup) |
| **Source paths** | `src/renderer/src/components/NewSessionModal.tsx`, `src/main/sessions/manager.ts`, `src/main/sessions/hosts.ts`, `src/main/sessions/ipc.ts`, `src/main/sessions/store.ts`, `src/main/harness/*` |
| **Catches** | New Session Modal flows (claude-code vs terminal mode, project-folder picker, remote path history/host options), session menu actions (rename/fork/restart/delete), resume of a prior session, terminal-only sessions. Use-worktree: modal closes immediately when "Use worktree" is checked, sidebar row shows `creating-worktree` state (dimmed, "Setting up worktree…" label), transitions to live status on success; on failure the row stays with a system error (no silent delete). |

### 3. Session Organization (Sidebar, Groups, Search, Filters, Tags)

| | |
|---|---|
| **Spec files** | `session-organization.spec.ts`, `weekly-plan-wizard.spec.ts` |
| **Source paths** | `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/panels/AppNotesPanel.tsx`, `src/renderer/src/components/panels/DailyNoteEditorPanel.tsx`, `src/renderer/src/components/panels/WeeklyPlanWizardPanel.tsx`, `src/main/weekly-note-io.ts`, `src/main/weekly-notes-handlers.ts`, `src/renderer/src/hooks/useDailyNoteNotesSlice.ts`, session store/manager (`src/main/sessions/store.ts`, `manager.ts`), `src/main/app-notes/*` |
| **Catches** | Sidebar search, status filters (all/attention/waiting), session groups (create/rename/drag), session detail popover (notes, tags, color swatch), command palette entry point from the sidebar, weekly plan sidebar row + guided wizard creating `02.weeklynotes/YYYY-Wnn.md`. |

### 4. Chat Transcript & Composer Core

| | |
|---|---|
| **Spec files** | `chat-surface-core.spec.ts`, `composer-core.spec.ts`, `harness-sdk-events.spec.ts`, `chat-transcript-window.spec.ts` |
| **Source paths** | `src/main/harness/*`, `src/main/sessions/manager.ts`, `src/main/sessions/session-harness-ui.ts`, `src/main/sessions/store.ts`, `src/shared/chat-transcript-window.ts`, `src/renderer/src/components/chat/*`, `src/shared/harness-ui-types.ts`, `Features/harness-sdk-events/spec.md`, `Features/chat-transcript-window/spec.md` |
| **Catches** | Sending a real message end-to-end, live todo-tracker updates from a real `TodoWrite` SDK call, transcript message rendering, chat transcript display window (last 40 user-turn conversations + truncation banner), composer send/stop-button behavior mid-stream, Markdown rendering of assistant text (bold/inline-code/fenced-code-blocks/lists/links via `MarkdownMessage.tsx`, with user messages and search-highlighting explicitly excluded from Markdown rendering), tool-call sequence collapsing into one expandable aggregate summary row (mid-turn aggregate+current-card, post-turn single-aggregate, expand/click behavior, single-tool-call no-aggregation, edit-vs-other collapsed-row content, subagent-nested sequence aggregation). SDK harness event UI (`harness-sdk-events.spec.ts` + `e2e/HARNESS_SDK_EVENTS_BUG_BASH.md`): composer turn hint, no REQUEST transcript card, tool elapsed, background/toast negatives. |

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
| **Spec files** | `enrichment-cost-tracking.spec.ts` (10a), `enrichment-full-text-search.spec.ts` (10b), `enrichment-export-conversation.spec.ts` (10c), `message-actions.spec.ts` (10d), `composer-mentions-and-commands.spec.ts` (10e), `model-effort-picker.spec.ts` (10f), `enrichment-image-attachment.spec.ts` (10g) |
| **Source paths** | `src/renderer/src/components/chat/ChatTranscript.tsx`, `TranscriptSearchBar.tsx`, `ExportMenu.tsx`, `MessageActions.tsx`, `Composer.tsx`; `src/main/sessions/export-format.ts` |
| **Catches** | Cost chip accuracy, transcript full-text search bar + match navigation, JSON/Markdown conversation export, message copy/speak, file mentions & slash commands, model/effort pickers, and image attachment (attach/thumbnail/remove in composer, render in transcript). Grouped here because these were built as a numbered enrichment series (10a-10g); see category 4-7 for the more general components each touches. |

### 9. Global Nav, Command Palette & Settings

| | |
|---|---|
| **Spec files** | `global-nav-and-settings.spec.ts`, `bug-keyboard-hint-labels.spec.ts` |
| **Source paths** | `src/renderer/src/components/CommandPalette.tsx`, `src/renderer/src/components/SettingsPanel.tsx`, `src/renderer/src/components/Sidebar.tsx` (collapsed rail mode), `src/renderer/src/components/OnboardingWizard.tsx`, `src/renderer/src/components/KeyboardHintsOverlay.tsx`, `src/renderer/src/keyboard-hints/*` |
| **Catches** | Command palette open/search/empty-state, collapsed sidebar rail toggle, Settings panel (theme light/dark, independent font-size sliders for interface/agent-message/terminal), desktop notification debug trigger, first-run onboarding wizard (shown once, name/email steps). ⌘-hold keyboard hints: label allocation stays unique, prefix-free and single-keystroke for as many targets as the alphabet allows, and the live overlay paints distinguishable badges. |

### 10. Secondary Panels (Diff, Files, Ports, Terminal, Worktrees)

| | |
|---|---|
| **Spec files** | `secondary-panels.spec.ts`, `terminal-pty.spec.ts` |
| **Source paths** | `src/renderer/src/components/panels/*` (`DiffPanel.tsx`, `FilesPanel.tsx`, `PortsPanel.tsx`, `TerminalPanel.tsx`, `TabBar.tsx`, `CompanionTerminalDrawer.tsx`), `src/main/panels/*` (`git.ts`, `files.ts`, `ports.ts`, `pty.ts`, `ipc.ts`) |
| **Catches** | Tab strip switching (chat/diff/files/ports), git diff sub-tabs (changes/commits/worktrees) including worktree add/merge/remove and diff inline comments, file tree browsing + content/image/HTML preview, port forwarding rows (add/remove/status), real PTY-backed terminal panel and the companion terminal drawer. SSH ControlMaster: verifies that opening a devpod terminal creates a `/tmp/atelier-ssh-*` multiplexing socket (proving `SSH_MUX_OPTS` are applied so subsequent SSH calls reuse the socket instead of doing a full crypto handshake). |

### 11. Daily Notes & Obsidian Sync

| | |
|---|---|
| **Spec files** | `obsidian-integration.spec.ts`, `bug-57-obsidian-external-edit-timeline-sync.spec.ts`, `bug-daily-note-template.spec.ts`, `bug-daily-notes-time-editing.spec.ts`, `task-move-to-date.spec.ts`, `todo-session-link.spec.ts`, `daily-note-notes-editor.spec.ts` |
| **Source paths** | `src/renderer/src/components/daily-notes/*` (`Timeline.tsx`, `DailyNotesSidebar.tsx`, `TaskItem.tsx`, `TaskMoveContextMenu.tsx`, `move-date-options.ts`, `CurrentTimeLine.tsx`, `section-resize.ts`, `timeline-scale.ts`, `TaskSessionLinkDialogs.tsx`), `src/renderer/src/components/panels/DailyNoteEditorPanel.tsx`, `src/renderer/src/hooks/useDailyNoteNotesSlice.ts`, `src/main/daily-note-io.ts`, `src/main/daily-notes-handlers.ts`, `src/main/daily-note-session-link.ts`, `src/main/sessions/store.ts`, `src/main/sessions/manager.ts`, `src/main/sessions/ipc.ts`, `src/renderer/src/App.tsx` |
| **Catches** | Parsing/rendering of real vault markdown fixtures into Timeline/Backlog/Delegated/Unscheduled, external-edit file-watch propagation (bug #57's parser mis-classification of moved tasks), vault-template-based daily note creation, right-click-to-create + edit tasks in the timeline, absolute-grid interactions (54a rewrite), list-management affordances (add-task/edit/tags/Big Three/collapse/close), current-time marker placement, section resize/carry-over on note creation, right-click "Move to..." context menu on Timeline/Unscheduled tasks and the cross-file move to another date's Backlog section — including target-note creation from the template and appending into an already-existing Backlog section (16-task-move-to-date, `task-move-to-date.spec.ts`). |

### 12. UI Chrome Bug Fixes (small, targeted repros)

| | |
|---|---|
| **Spec files** | `bug-remove-version-corner.spec.ts`, `bug-tracker-rail-width.spec.ts` |
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
