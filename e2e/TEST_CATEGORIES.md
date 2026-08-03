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
3. **This is a development-speed aid only.** Per `CLAUDE.md` §3, a change is
   not validated until the **full** suite passes:
   ```bash
   npm run test:e2e
   ```
   Category runs catch regressions in the area you touched fast; they do
   *not* catch cross-feature state bleed (shared sidebar/session state,
   global CSS, IPC plumbing shared across features) that only the full suite
   exercises. Never skip the full run before calling a change "done."
4. If a spec touches multiple areas (several do — most launch through the
   same New Session Modal / Composer flow as setup), it's listed under every
   category it meaningfully covers, not just its "primary" one.

---

## Categories

### 1. App Shell & Bootstrapping

| | |
|---|---|
| **Spec files** | `app-shell.spec.ts` |
| **Source paths** | `src/main/index.ts`, `src/main/logger.ts`, `src/main/config.ts`, `src/renderer/src/styles/*` (shared.css tokens), preload bridge (`window.gardenia`) |
| **Catches** | Window title/launch, `#root` mounting, the `app:getVersion` IPC round-trip, main-process log file creation (`app ready`, IPC entries), and that the shell renders real design tokens instead of Electron/browser defaults. |

### 2. Session Lifecycle (New Session, Modes, Resume/Fork/Rename/Delete)

| | |
|---|---|
| **Spec files** | `session-lifecycle.spec.ts`, `bug-new-session-path-history.spec.ts`, `bug-slash-model-command-missing.spec.ts` (setup path only), `secondary-panels.spec.ts` (terminal-only session setup) |
| **Source paths** | `src/renderer/src/components/NewSessionModal.tsx`, `src/main/sessions/manager.ts`, `src/main/sessions/hosts.ts`, `src/main/sessions/ipc.ts`, `src/main/sessions/store.ts`, `src/main/harness/*` |
| **Catches** | New Session Modal flows (claude-code vs terminal mode, project-folder picker, remote path history/host options), session menu actions (rename/fork/restart/delete), resume of a prior session, terminal-only sessions. |

### 3. Session Organization (Sidebar, Groups, Search, Filters, Tags)

| | |
|---|---|
| **Spec files** | `session-organization.spec.ts` |
| **Source paths** | `src/renderer/src/components/Sidebar.tsx`, session store/manager (`src/main/sessions/store.ts`, `manager.ts`) |
| **Catches** | Sidebar search, status filters (all/attention/waiting), session groups (create/rename/drag), session detail popover (notes, tags, color swatch), command palette entry point from the sidebar. |

### 4. Chat Transcript & Composer Core

| | |
|---|---|
| **Spec files** | `chat-surface-core.spec.ts`, `composer-core.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/ChatTranscript.tsx`, `src/renderer/src/components/chat/Composer.tsx`, `src/renderer/src/components/chat/TrackerRail.tsx`, `src/renderer/src/components/chat/ToolCallCard.tsx` |
| **Catches** | Sending a real message end-to-end, live todo-tracker updates from a real `TodoWrite` SDK call, transcript message rendering, composer send/stop-button behavior mid-stream. |

### 5. Composer Mentions, Slash Commands & Model Picker

| | |
|---|---|
| **Spec files** | `composer-mentions-and-commands.spec.ts`, `bug-slash-model-command-missing.spec.ts`, `bug-model-picker-option-list.spec.ts`, `model-effort-picker.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/Composer.tsx` (mention/slash popovers, `/model` interception), model-picker/effort-picker UI inside `Composer.tsx` |
| **Catches** | `@file` mention popover + selection, `/` slash-command popover, that `/model` is intercepted locally (never sent as literal chat text) and opens the Model Picker, that the picker's catalog is accurate (no stale/invented model ids, fable/mythos present), and the effort (low/medium/high) sub-picker. |

### 6. Interactive Prompts (Permissions, Plan Mode, Ask-User-Question)

| | |
|---|---|
| **Spec files** | `interactive-prompts.spec.ts`, `bug-ask-user-question-explicit-submit.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/PermissionRequestCard.tsx`, `src/renderer/src/components/chat/PlanProposedCard.tsx`, `src/renderer/src/components/chat/AskUserQuestionCard.tsx`, `src/main/harness/claude-agent-sdk-harness.ts` |
| **Catches** | Real permission-request round-trips (allow/always-allow/deny), plan-mode proposal accept/reject, `AskUserQuestion` card option selection requiring an explicit submit click (not an instant single-click submit). |

### 7. Message Actions (Copy / Speak)

| | |
|---|---|
| **Spec files** | `message-actions.spec.ts` |
| **Source paths** | `src/renderer/src/components/chat/MessageActions.tsx` |
| **Catches** | Per-message copy button and text-to-speech (speak) button + speaking indicator. |

### 8. Enrichment Features (10a-10g)

| | |
|---|---|
| **Spec files** | `enrichment-cost-tracking.spec.ts` (10a), `enrichment-full-text-search.spec.ts` (10b), `enrichment-export-conversation.spec.ts` (10c), `message-actions.spec.ts` (10d), `composer-mentions-and-commands.spec.ts` (10e), `model-effort-picker.spec.ts` (10f), `enrichment-image-attachment.spec.ts` (10g) |
| **Source paths** | `src/renderer/src/components/chat/ChatTranscript.tsx`, `TranscriptSearchBar.tsx`, `ExportMenu.tsx`, `MessageActions.tsx`, `Composer.tsx`; `src/main/sessions/export-format.ts` |
| **Catches** | Cost chip accuracy, transcript full-text search bar + match navigation, JSON/Markdown conversation export, message copy/speak, file mentions & slash commands, model/effort pickers, and image attachment (attach/thumbnail/remove in composer, render in transcript). Grouped here because these were built as a numbered enrichment series (10a-10g); see category 4-7 for the more general components each touches. |

### 9. Global Nav, Command Palette & Settings

| | |
|---|---|
| **Spec files** | `global-nav-and-settings.spec.ts` |
| **Source paths** | `src/renderer/src/components/CommandPalette.tsx`, `src/renderer/src/components/SettingsPanel.tsx`, `src/renderer/src/components/Sidebar.tsx` (collapsed rail mode), `src/renderer/src/components/OnboardingWizard.tsx` |
| **Catches** | Command palette open/search/empty-state, collapsed sidebar rail toggle, Settings panel (theme light/dark, independent font-size sliders for interface/agent-message/terminal), desktop notification debug trigger, first-run onboarding wizard (shown once, name/email steps). |

### 10. Secondary Panels (Diff, Files, Ports, Terminal, Worktrees)

| | |
|---|---|
| **Spec files** | `secondary-panels.spec.ts` |
| **Source paths** | `src/renderer/src/components/panels/*` (`DiffPanel.tsx`, `FilesPanel.tsx`, `PortsPanel.tsx`, `TerminalPanel.tsx`, `TabBar.tsx`, `CompanionTerminalDrawer.tsx`), `src/main/panels/*` (`git.ts`, `files.ts`, `ports.ts`, `pty.ts`, `ipc.ts`) |
| **Catches** | Tab strip switching (chat/diff/files/ports), git diff sub-tabs (changes/commits/worktrees) including worktree add/merge/remove and diff inline comments, file tree browsing + content/image/HTML preview, port forwarding rows (add/remove/status), real PTY-backed terminal panel and the companion terminal drawer. |

### 11. Daily Notes & Obsidian Sync

| | |
|---|---|
| **Spec files** | `obsidian-integration.spec.ts`, `bug-57-obsidian-external-edit-timeline-sync.spec.ts`, `bug-daily-note-template.spec.ts`, `bug-daily-notes-time-editing.spec.ts` |
| **Source paths** | `src/renderer/src/components/daily-notes/*` (`Timeline.tsx`, `DailyNotesSidebar.tsx`, `TaskItem.tsx`, `CurrentTimeLine.tsx`, `section-resize.ts`, `timeline-scale.ts`), `src/main/daily-note-io.ts`, `src/main/daily-notes-handlers.ts` |
| **Catches** | Parsing/rendering of real vault markdown fixtures into Timeline/Backlog/Delegated/Unscheduled, external-edit file-watch propagation (bug #57's parser mis-classification of moved tasks), vault-template-based daily note creation, right-click-to-create + edit tasks in the timeline, absolute-grid interactions (54a rewrite), list-management affordances (add-task/edit/tags/Big Three/collapse/close), current-time marker placement, section resize/carry-over on note creation. |

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
| **Catches** | Real `BrowserWindow` resize across 5 sizes x 4 app states, checking for sibling-panel overlap and unintended content-hiding overflow (excluding intentionally-scrollable containers); real scroll behavior in transcript/sidebar/tracker/daily-notes bodies (not just overflow metrics) via mention popover, timeline task, and tracker-task interactions while scrolled. These are cross-cutting regression nets, not single-feature specs — expect to run them whenever touching shared layout/CSS, even if your change is "in" another category. |

---

## Notes on scope overlap

Nearly every spec launches through the same New Session Modal boilerplate
(`new-session-button` -> `new-session-modal` -> `pick-project-folder` ->
`mode-claude-code`/`mode-terminal` -> `initial-prompt` -> `start-session-button`),
so a regression in `NewSessionModal.tsx` or `src/main/sessions/*` can show up
as failures across nearly all categories above, not just category 2. If
you're touching session-creation/bootstrap code, don't rely on a single
category's specs — run the full suite.
