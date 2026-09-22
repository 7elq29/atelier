import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { HarnessDriver, HarnessEvent, HarnessSession, HarnessStartOptions, PromptResponse, RemoteHost } from '../harness/types'
import { logger } from '../logger'
import type {
  CreateSessionOptions,
  FileAttachment,
  MessageRecord,
  ModelInfo,
  ModelSelection,
  MessageSearchHit,
  PendingQueuedMessage,
  PermissionModeValue,
  PromptDecision,
  RemoteHostOption,
  SessionGroupEvent,
  SessionGroupRecord,
  SessionInterruptResult,
  SessionLifecycleEvent,
  SessionRecord,
  SessionStatus,
  SessionTab,
  SlashCommandInfo
} from '../../shared/session-types'
import type { DiffFileChange, DiffFileContentPair } from '../../shared/panel-types'
import type { SessionWorkspacePayload } from '../../shared/session-workspace-types'
import type { SessionChangesCap } from '../../shared/session-changes-cap'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark,
  SessionBookmarkKind,
  SessionBookmarksUpdatedEvent
} from '../../shared/session-bookmarks'
import { normalizeSessionBookmarkTarget } from '../../shared/session-bookmarks'
import { TURN_INTERRUPTED_NOTICE } from '../../shared/session-types'
import { formatHarnessErrorForUser } from '../../shared/harness-error-copy'
import type { SessionMessagesResult } from '../../shared/chat-transcript-window'
import { defaultClaudeModelFromConfig, defaultClaudeEffortFromConfig, defaultClaudePermissionModeFromConfig } from '../../shared/config'
import { expandTildePath } from '../../shared/project-path-autocomplete'
import { loadConfig } from '../config'
import { SSH_MUX_OPTS } from '../ssh-exec'
import type {
  AskUserQuestionContent,
  CompactionContent,
  FilesAttachmentContent,
  PermissionRequestContent,
  PlanProposedContent,
  ToolCallContent,
  ThinkingBlockContent,
  TodoUpdateContent
} from '../../shared/chat-content'
import { parseStructuredContent } from '../../shared/chat-content'
import type { SessionStore } from './store'
import { suggestProjectPaths as computeProjectPathSuggestions } from './project-path-suggest'
import { worktreeRootFromConfig, sessionWorktreePath } from '../../shared/worktree-path'
import { worktreeSystemPromptAppend } from '../../shared/worktree-prompt'
import { homeDirForWorktreeHost } from './worktree-home'
import { createWorktree, removeWorktree, worktreePathExists } from './worktree'
import { warmRemoteGitHost } from '../panels/git'
import { invalidateGitRepository } from '../panels/git-repository'
import { getSessionCapOutsideFileDiff, getSessionCapGitFileDiff, registerPlanFileInSessionChangesCap, bashCommandMayAffectSessionChanges, registerFileEditToolTouchedPaths } from './session-changes-cap'
import { isSessionFileEditTool } from '../../shared/session-file-edits'
import { WorkspaceService, LOCAL_GIT_DEBOUNCE_MS } from './workspace-service'
import { scheduleHostStartupReconnect } from './remote-preload-gate'
import { applyBashCdCommands } from './harness-cwd'
import { SessionHarnessUiState } from './session-harness-ui'
import { removeClaudeSessionFiles } from './session-artifact-cleanup'
import type {
  SessionAuthStatusEvent,
  SessionBackgroundTasksEvent,
  SessionRateLimitEvent,
  SessionSdkChromeEvent,
  SessionToastEvent,
} from '../../shared/harness-ui-types'
import type { LocalCommandOutputContent, TranscriptNoticeContent } from '../../shared/chat-content'
import { completeLinkedDailyTask, linkDailyTaskToSession } from '../daily-note-session-link'
import type { PortForwardManager } from '../panels/ports'

const AUTO_NAME_STARTING_FROM_TURN = 2
const AUTO_NAME_MAX_WORDS = 3
const AUTO_NAME_MAX_LEN = 25
const AUTO_NAME_PROMPT = `Summarize this conversation topic in under ${AUTO_NAME_MAX_WORDS} words (max ${AUTO_NAME_MAX_LEN} characters). Reply with ONLY the title, no punctuation, no quotes.`
const MIN_SESSION_CLEANUP_VISIBLE_MS = 600

/** Models sometimes ignore the word-count prompt — clamp to one line, ≤3 words, ≤25 chars. */
function clampSessionTitle(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const cleaned = firstLine.replace(/^["'“”]+|["'“”]+$/g, '')
  if (!cleaned) return ''
  let title = cleaned.split(/\s+/).filter(Boolean).slice(0, AUTO_NAME_MAX_WORDS).join(' ')
  if (title.length <= AUTO_NAME_MAX_LEN) return title
  title = title.slice(0, AUTO_NAME_MAX_LEN).trimEnd()
  const lastSpace = title.lastIndexOf(' ')
  if (lastSpace > 0) title = title.slice(0, lastSpace)
  return title
}

/** Skip auto harness reconnect on relaunch when last active is older than this (session-startup-idle). */
export const SESSION_STARTUP_IDLE_MS = 60 * 60 * 1000

/**
 * The composer's Shift+Tab cycle order (11-composer-mode-indicator) — matches
 * Claude Code's own CLI cycle exactly (spec.md's scope decision). NOT the
 * full set of SDK-supported permission modes: `bypassPermissions`/`dontAsk`
 * are deliberately excluded from this app-level cycle.
 */
const MODE_CYCLE: PermissionModeValue[] = ['default', 'plan', 'acceptEdits', 'auto']

/** Bookkeeping for one still-running tool call, keyed by its toolUseId. */
interface PendingToolCall {
  messageId: number
  content: ToolCallContent
}

/** Bookkeeping for one still-pending interactive prompt, keyed by its requestId (05-interactive-prompts). */
interface PendingPrompt {
  messageId: number
  content: PermissionRequestContent | AskUserQuestionContent | PlanProposedContent
}

/** In-memory bookkeeping for a session's live harness stream, keyed by our session id. */
/** Full payload for one item in a per-session turn queue. */
interface QueueEntry {
  id: string
  text: string
  attachments?: FileAttachment[]
  modelOverride?: ModelSelection
  userMessageId: number | null
}

interface LiveStream {
  /** Assembled text for the assistant turn currently in progress (flushed on tool-call or result). */
  buffer: string
  /**
   * DB id of the (already-persisted, currently empty-or-partial) message row
   * backing `buffer` — created on the first `text_delta` of a segment so
   * `session:streamDelta` pushes have a stable id to target, then updated
   * in place with the final text on flush. `null` when no segment is open.
   */
  bufferMessageId: number | null
  /** Number of completed assistant turns ('result' events) seen so far. */
  turnCount: number
  /**
   * Most recent raw `totalCostUsd` reported by the SDK on this connection
   * (Bug: fix-session-cost-total-overcounted). Verified for real (3-turn
   * probe, raw main.log): the SDK's `result.total_cost_usd` is CUMULATIVE
   * for the current `query()` connection, not a per-turn delta — turn 2 on
   * a connection reported its own standalone cost, but turn 3 on the SAME
   * connection (no resume in between) reported turn2+turn3 combined. It
   * resets to a fresh 0 baseline on every new connection (`start()`/
   * `resume()`) rather than carrying the historical session cost forward.
   * So the true per-turn spend to persist is
   * `event.totalCostUsd - connectionCostUsd` (this connection's last seen
   * value), and this field must reset to 0 whenever a genuinely new
   * connection starts (see `newLiveStream()` call sites) but persist
   * across turns fed via `streamInput()` on the same connection.
   */
  connectionCostUsd: number
  /** Tool calls started but not yet ended, keyed by toolUseId. */
  pendingTools: Map<string, PendingToolCall>
  /**
   * True from the moment a prompt is sent/streamed into this session until
   * its turn's terminal event (result/error/interrupted) — drives the
   * 'working' status (06-session-organization).
   */
  busy: boolean
  /** Interactive prompts awaiting a user decision, keyed by requestId (05-interactive-prompts). */
  pendingPrompts: Map<string, PendingPrompt>
  /** Latest Claude Code cwd for this connection (SDK init + inferred Bash `cd`). */
  harnessCwd: string | null
  /** Open extended-thinking card for the current assistant segment (partial stream). */
  thinkingMessageId: number | null
  thinkingText: string
  thinkingParentToolUseId: string | null
  thinkingEstimatedTokens?: number
  /** User message for the in-flight turn while ESC can still withdraw it pre-execution. */
  pendingUserMessageId: number | null
  /** True once the harness has started producing turn output for the pending user message. */
  turnExecutionStarted: boolean
  /** Set when the user hits Stop/ESC — drop late stream events until the terminal harness event. */
  interruptRequested: boolean
}


/**
 * Matches the CLI's own error text for a `resume()` against a session id it
 * has no backend-side record of at all (see `SessionManager.
 * withConversationLostFallback`'s doc comment) — verified for real via a
 * standalone `claude --resume <id>` probe against a deleted transcript file:
 * stderr `"No conversation found with session ID: <id>"`. Deliberately loose
 * (case-insensitive substring, no exact id/format match) so it also catches
 * the same phrasing surfacing through `initializationResult()` rejecting
 * with `"Claude Code returned an error result: No conversation found with
 * session ID: <id>"` — both wrap the identical underlying CLI message.
 */
function isConversationLostError(message: string): boolean {
  return /no conversation found/i.test(message)
}

/**
 * Matches the CLI's distinct `"Session ID <id> is already in use"` error —
 * verified for real (SDK-level probe, see `startFreshWithRetry`'s doc
 * comment) to be a genuine but narrow race specifically when a
 * `startWithId()` fallback immediately follows a failed `resume()` for a
 * still-streaming (`keepAlive: true`) session, NOT the `"no conversation
 * found"` failure itself.
 */
function isSessionLockRaceError(message: string): boolean {
  return /is already in use/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function newLiveStream(turnCount = 0): LiveStream {
  return {
    buffer: '',
    bufferMessageId: null,
    turnCount,
    connectionCostUsd: 0,
    pendingTools: new Map(),
    busy: false,
    pendingPrompts: new Map(),
    harnessCwd: null,
    thinkingMessageId: null,
    thinkingText: '',
    thinkingParentToolUseId: null,
    pendingUserMessageId: null,
    turnExecutionStarted: false,
    interruptRequested: false,
  }
}

function userMessagePlainText(content: string): string {
  const parsed = parseStructuredContent(content)
  if (parsed?.kind === 'image_attachment') return parsed.text ?? ''
  return content
}

export interface RemoteHostResolver {
  list(): RemoteHostOption[]
  resolve(hostId: string): RemoteHostOption | undefined
  /** Looks up a host by its stored SSH hostname (sessions.hostname), used to re-resolve remoteExecutablePath etc. on resume/reconnect. */
  resolveByHostname(sshHost: string): RemoteHostOption | undefined
}

/**
 * Orchestrates the harness + SQLite store for the full session lifecycle
 * (02-session-lifecycle): create/resume/fork/restart/close/delete/rename,
 * live event streaming into `messages` + IPC push to the renderer, and the
 * auto-naming background summarizer (guarded against Playground's Bug #93 —
 * see `SessionStore.setAutoName`, the only place a name is ever
 * auto-applied).
 */
export class SessionManager {
  private readonly live = new Map<string, LiveStream>()
  /** Sessions whose Atelier worktree checkout was checked and absent — skip repeat SSH stat on every send. */
  private readonly worktreeMissingChecked = new Set<string>()
  /** Sessions currently between a triggered `reconnect()` and the live harness connection actually being (re)established — see `getStatus()`'s 'connecting' case (fix-session-resume-stale-sigterm-and-no-connect-indicator). */
  private readonly connecting = new Set<string>()
  /** Sessions currently being set up with an async worktree creation — see `getStatus()`'s 'creating-worktree' case. */
  private readonly creatingWorktree = new Set<string>()
  /** Dedupes explicit deletes and startup retries for durable two-phase cleanup. */
  private readonly sessionCleanupInFlight = new Map<string, Promise<void>>()
  /** Open claude-code sessions left disconnected on launch due to 1h+ inactivity (session-startup-idle). */
  private readonly startupIdle = new Set<string>()
  /** After reconnect(), the first harness event triggers panel preload in the renderer. */
  private readonly pendingPanelPreload = new Set<string>()
  /** `completeSessionOpen()` in flight — keep `connecting` until diff/workspace preload finishes. */
  private readonly workspacePreloadInFlight = new Set<string>()
  /** startupReconnect() paths — must not bump last_active_at when the harness connects. */
  private readonly startupAutoReconnect = new Set<string>()
  /**
   * Tracks the current SDK permission mode for a session (05-interactive-
   * prompts; generalized from plan-only to all 4 `MODE_CYCLE` values in
   * 11-composer-mode-indicator), across `resume()` reconnects. The SDK's
   * `permissionMode` is per-`query()` call, NOT restored automatically from a
   * `--resume`d session's history — verified live: without re-passing
   * `permissionMode: 'plan'` on every `harness.resume()` call while a plan is
   * still un-approved, a follow-up composer message reconnects in the SDK's
   * default mode, and a REJECTED plan's `ExitPlanMode` retry then fails
   * outright ("I'm no longer in plan mode") because the CLI itself
   * short-circuits the tool before `canUseTool` is ever invoked. Populated
   * for sessions started with `planMode: true` (-> `'plan'`) and any session
   * whose composer has cycled its mode at least once; absent (treated as
   * `'default'` via `decorate()` below) for every other session, unchanged
   * from before this task. Flips to `'default'` the moment a plan is
   * genuinely accepted (see `respondToPrompt` below), mirroring the real
   * SDK-side state transition — a cycle initiated after that starts counting
   * from `'default'` again, same as a session that was never in plan mode.
   */
  private readonly permissionModes = new Map<string, PermissionModeValue>()

  /**
   * Tracks the model/effort override currently applied to a session's live
   * harness connection (10f-enrichment-model-effort-picker), across
   * `resume()` reconnects — same "sticky, re-passed on every reconnect"
   * pattern as `permissionModes` above. Populated the first time
   * `sendUserMessage` is called with an explicit override; absent entirely
   * for a session whose composer never touched the model/effort picker (in
   * which case every `resume()`/`start()` call omits `model`/`effort`
   * altogether, preserving the harness's own default — unchanged from every
   * caller that predates this task).
   */
  private readonly modelSelections = new Map<string, ModelSelection>()

  /** Bumped on close/delete to drop stale `consume()` loops (pty generation pattern). */
  private readonly consumeGeneration = new Map<string, number>()

  /**
   * Per-session FIFO queue of messages waiting for the current SDK turn to
   * complete. The main process owns this queue; the renderer no longer needs
   * its own busy-gated queue state. Each item carries the full payload needed
   * for dispatch (text, attachments, model override). `inflightId` is the id
   * of the item currently dispatched to the harness — null when idle.
   */
  private readonly turnQueues = new Map<string, { items: QueueEntry[]; inflightId: string | null }>()

  /** Debounced cap + workspace refresh after file edits / mutating git Bash — coalesces multi-tool turns. */
  private readonly capRefreshDebounce = new Map<string, ReturnType<typeof setTimeout>>()

  private readonly harnessUi = new SessionHarnessUiState()

  private workspace: WorkspaceService | null = null
  private portForwards: PortForwardManager | null = null

  setWorkspaceService(workspace: WorkspaceService): void {
    this.workspace = workspace
  }

  setPortForwardManager(portForwards: PortForwardManager): void {
    this.portForwards = portForwards
  }

  getWorkspaceService(): WorkspaceService | null {
    return this.workspace
  }

  private bumpConsumeGeneration(sessionId: string): number {
    const next = (this.consumeGeneration.get(sessionId) ?? 0) + 1
    this.consumeGeneration.set(sessionId, next)
    return next
  }

  private invalidateConsume(sessionId: string): void {
    this.bumpConsumeGeneration(sessionId)
  }

  private async waitUntilNotConnecting(sessionId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.connecting.has(sessionId) && Date.now() < deadline) {
      await delay(50)
    }
  }

  private publishSessionChangesCap(sessionId: string, cap: SessionChangesCap): void {
    if (!this.workspace) return
    if (this.workspace.getCached(sessionId)) {
      this.workspace.patchSessionChangesCap(sessionId, cap)
    }
    // No cache yet — preloadSession will include cap; avoid force-refreshing files.
  }

  private scheduleCapRefreshAfterMutation(sessionId: string): void {
    const existing = this.capRefreshDebounce.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.capRefreshDebounce.delete(sessionId)
      void this.refreshSessionWorkspace(sessionId, false, { skipCapRebuild: true }).catch(() => undefined)
    }, LOCAL_GIT_DEBOUNCE_MS)
    this.capRefreshDebounce.set(sessionId, timer)
  }

  private clearCapRefreshDebounce(sessionId: string): void {
    const existing = this.capRefreshDebounce.get(sessionId)
    if (existing) clearTimeout(existing)
    this.capRefreshDebounce.delete(sessionId)
  }

  constructor(
    private readonly store: SessionStore,
    private readonly harness: HarnessDriver,
    private readonly hosts: RemoteHostResolver,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  /**
   * Overlays the tracked-in-memory `permissionModes` entry (or `'default'`)
   * onto a DB-sourced `SessionRecord` (11-composer-mode-indicator) — mode is
   * NOT a DB column (same non-persisted-across-a-real-app-relaunch tradeoff
   * the pre-existing plan-mode tracking already made; see `permissionModes`'
   * doc comment), so every read path that hands a `SessionRecord` to the
   * renderer must go through this rather than returning the store's row
   * as-is.
   */
  private decorate(session: SessionRecord): SessionRecord {
    return {
      ...session,
      permissionMode: this.permissionModes.get(session.id) ?? session.permissionMode,
      modelSelection: this.modelSelections.get(session.id) ?? session.modelSelection ?? null
    }
  }

  listActive(): SessionRecord[] {
    return this.store.listActiveSessions().map((s) => this.decorate(s))
  }

  listHistory(): SessionRecord[] {
    return this.store.listHistorySessions().map((s) => this.decorate(s))
  }

  listMessages(sessionId: string): MessageRecord[] {
    return this.store.listMessages(sessionId)
  }

  listMessagesForDisplay(
    sessionId: string,
    opts?: { includeMessageId?: number }
  ): SessionMessagesResult {
    return this.store.listMessagesForDisplay(sessionId, undefined, opts?.includeMessageId)
  }

  listSessionFileEdits(sessionId: string) {
    return this.store.listSessionFileEdits(sessionId)
  }

  /** Looks up a single session record by id (10c-enrichment-export-conversation), undefined if it doesn't exist. */
  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.store.getSession(sessionId)
    return session ? this.decorate(session) : undefined
  }

  getSessionWorkspaceSnapshot(sessionId: string): SessionWorkspacePayload | null {
    return this.workspace?.getCached(sessionId) ?? null
  }

  listSessionBookmarks(sessionId: string): SessionBookmark[] {
    if (!this.store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    return this.store.listSessionBookmarks(sessionId)
  }

  addSessionBookmark(sessionId: string, input: CreateSessionBookmarkInput): SessionBookmark[] {
    if (!this.store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    const target = normalizeSessionBookmarkTarget(input.kind, input.target)
    if (!target) throw new Error('Bookmark target is required')
    if (input.kind === 'link') {
      const parsed = new URL(target)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP(S) links can be bookmarked')
      }
    }
    this.store.addSessionBookmark(sessionId, {
      ...input,
      target,
      label: input.label.trim().slice(0, 300) || target
    })
    return this.sendBookmarksUpdated(sessionId)
  }

  removeSessionBookmark(
    sessionId: string,
    kind: SessionBookmarkKind,
    target: string
  ): SessionBookmark[] {
    if (!this.store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    this.store.removeSessionBookmark(
      sessionId,
      kind,
      normalizeSessionBookmarkTarget(kind, target)
    )
    return this.sendBookmarksUpdated(sessionId)
  }

  private sendBookmarksUpdated(sessionId: string): SessionBookmark[] {
    const bookmarks = this.store.listSessionBookmarks(sessionId)
    const event: SessionBookmarksUpdatedEvent = { sessionId, bookmarks }
    this.getWindow()?.webContents.send('session:bookmarksUpdated', event)
    return bookmarks
  }

  getSessionWorkspaceRefreshDiagnostics(sessionId: string) {
    return this.workspace?.getRefreshDiagnostics(sessionId) ?? null
  }

  async refreshSessionWorkspace(
    sessionId: string,
    force: boolean,
    opts?: { includeFiles?: boolean; skipCapRebuild?: boolean }
  ): Promise<SessionWorkspacePayload | null> {
    const session = this.getSession(sessionId)
    if (!session || session.mode !== 'claude-code' || !this.workspace) return null
    return this.workspace.refreshWorkspace(session, force, opts)
  }

  getCapOutsideFileDiff(
    sessionId: string,
    workspacePath: string,
    capPath: string
  ): Promise<{ file: DiffFileChange; pair: DiffFileContentPair } | null> {
    const session = this.getSession(sessionId)
    if (!session) return Promise.resolve(null)
    return getSessionCapOutsideFileDiff(
      this.store,
      sessionId,
      workspacePath,
      capPath,
      session.hostname,
      session.projectPath
    )
  }

  getCapGitFileDiff(
    sessionId: string,
    workspacePath: string,
    capPath: string
  ): Promise<DiffFileChange | null> {
    const session = this.getSession(sessionId)
    if (!session) return Promise.resolve(null)
    return getSessionCapGitFileDiff(workspacePath, capPath, session.hostname)
  }

  /** Test-only: feed harness UI events through the real apply/send path (e2e). */
  debugApplyHarnessUiEvents(sessionId: string, events: HarnessEvent[]): void {
    if (!this.getSession(sessionId)) return
    for (const event of events) {
      this.applyHarnessUiSideEffects(sessionId, { ...event, sessionId })
    }
  }

  /** Test-only: register inline plan in session changes cap (e2e). Does not write plan files. */
  async debugRegisterPlanInCap(
    sessionId: string,
    args: { plan: string; planFilePath?: string; toolUseId: string }
  ): Promise<SessionChangesCap | null> {
    const session = this.getSession(sessionId)
    if (!session) return null
    const message = this.store.addMessage({
      sessionId,
      role: 'assistant',
      content: JSON.stringify({
        kind: 'plan_proposed',
        requestId: 'debug',
        toolUseId: args.toolUseId,
        plan: args.plan,
        planFilePath: args.planFilePath,
        status: 'pending'
      })
    })
    // The real harness path pushes every stored message to the renderer, and the cap's plan rows
    // read their editions out of the renderer's transcript — skipping this leaves the row unopenable.
    this.sendMessage(sessionId, message)
    const workspaceRoot = session.worktreePath ?? session.projectPath
    const cap = await registerPlanFileInSessionChangesCap(
      this.store,
      sessionId,
      workspaceRoot,
      workspaceRoot,
      session.hostname
    )
    this.publishSessionChangesCap(sessionId, cap)
    return cap
  }

  /** Cross-session content search (10b-enrichment-full-text-search), backing the command palette's extended "Session" results. */
  searchMessages(query: string): MessageSearchHit[] {
    return this.store.searchMessages(query)
  }

  listHosts(): RemoteHostOption[] {
    return this.hosts.list()
  }

  /** Recently-used project paths for `hostId` ('local' or a RemoteHostOption.id), newest first (fix-bug-triage-jul31 / bug #49). */
  listRecentProjectPaths(hostId: string): string[] {
    return this.store.listRecentProjectPaths(hostId)
  }

  suggestProjectPaths(hostId: string, query: string) {
    return computeProjectPathSuggestions(hostId, query, this.store, this.hosts)
  }

  private sendLifecycle(event: SessionLifecycleEvent): void {
    logger.info('session lifecycle event', {
      event: event.type,
      sessionId: 'session' in event ? event.session.id : event.sessionId,
      // Full record on rename/close/resume/fork so e2e can grep e.g.
      // `"event":"session.renamed"` alongside `"nameLockedByUser":true` on
      // the SAME line, per e2e-test-plan.md's proof-artifact expectations.
      session: 'session' in event ? event.session : undefined,
      sourceId: 'sourceId' in event ? event.sourceId : undefined
    })
    this.getWindow()?.webContents.send('session:lifecycle', event)
  }

  private sendMessage(sessionId: string, message: MessageRecord): void {
    this.getWindow()?.webContents.send('session:message', { sessionId, message })
  }

  private sendMessageRemoved(sessionId: string, messageId: number): void {
    this.getWindow()?.webContents.send('session:messageRemoved', { sessionId, messageId })
  }

  private sendMessagesCleared(sessionId: string): void {
    this.getWindow()?.webContents.send('session:messagesCleared', { sessionId })
  }

  /** Live, unpersisted token-level push for the in-progress assistant text message `messageId` — see `SessionStreamDeltaEvent`. */
  private sendStreamDelta(sessionId: string, messageId: number, text: string): void {
    this.getWindow()?.webContents.send('session:streamDelta', { sessionId, messageId, text })
  }

  // ── Live status (06-session-organization) ────────────────────────────
  //
  // See SessionStatus's doc comment (shared/session-types.ts) for the exact
  // definitions. Pushed to EVERY sidebar row in real time — not just the
  // currently-viewed session — via `session:status`, independent of which
  // session (if any) is focused in the renderer.

  /** Durable cleanup wins over every transient runtime status. */
  getStatus(sessionId: string): SessionStatus {
    if (this.store.getSession(sessionId)?.deletedAt) return 'cleaning-up'
    if (this.creatingWorktree.has(sessionId)) return 'creating-worktree'
    if (this.connecting.has(sessionId)) return 'connecting'
    if (!this.live.has(sessionId) && this.isSessionStartupIdle(sessionId)) return 'startup-idle'
    const live = this.live.get(sessionId)
    if (!live) return 'idle'
    return live.busy ? 'working' : 'waiting'
  }

  /** Snapshot of every open session's live/startup status for the renderer's initial paint. */
  listStatuses(): Record<string, SessionStatus> {
    const result: Record<string, SessionStatus> = {}
    for (const session of this.store.listActiveSessions()) {
      result[session.id] = this.getStatus(session.id)
    }
    return result
  }

  /**
   * Classifies 1h+ inactive claude-code sessions before the renderer can
   * select them (session-startup-idle). Must run synchronously at launch,
   * not inside the delayed startupReconnect() window.
   *
   * idle-session-auto-history: eligible sessions are auto-closed into History
   * instead of staying in the active sidebar as startup-idle.
   */
  markStartupIdleSessions(): void {
    for (const session of this.store.listActiveSessions()) {
      if (session.deletedAt) continue
      if (session.mode !== 'claude-code') continue
      if (!this.sessionIsStartupIdleEligible(session)) continue
      void this.closeSession(session.id)
    }
  }

  private touchLastActive(sessionId: string): void {
    this.store.touchLastActive(sessionId)
  }

  /** Restores auto-naming turn bookkeeping after a harness reconnect (session-startup-idle). */
  private initialTurnCountForReconnect(sessionId: string): number {
    return this.store.listMessages(sessionId).filter((m) => m.role === 'user').length
  }

  private sessionIsStartupIdleEligible(session: SessionRecord): boolean {
    const last = Date.parse(session.lastActiveAt)
    if (Number.isNaN(last)) return false
    return Date.now() - last > SESSION_STARTUP_IDLE_MS
  }

  /** Records user focus on a session (sidebar select) for startup-idle eligibility. */
  touchSessionActive(sessionId: string): void {
    if (!this.store.getSession(sessionId)) return
    // Browsing a disconnected (1h+) session must not bump last_active_at —
    // that would make every stale session auto-reconnect on the next launch.
    if (this.isSessionStartupIdle(sessionId)) return
    this.touchLastActive(sessionId)
  }

  /** Open claude-code session left disconnected on launch (session-startup-idle). */
  isSessionStartupIdle(sessionId: string): boolean {
    if (this.live.has(sessionId) || this.connecting.has(sessionId)) return false
    if (this.startupIdle.has(sessionId)) return true
    const session = this.store.getSession(sessionId)
    if (!session || session.mode !== 'claude-code' || session.closedAt) return false
    return this.sessionIsStartupIdleEligible(session)
  }

  /**
   * idle-session-auto-history: long-inactive disconnected claude-code sessions
   * (`startup-idle`) are closed into History automatically. Plain `idle`
   * (e.g. right after a failed reconnect) is left in the active list so errors
   * stay visible until the user closes manually.
   */
  private maybeAutoCloseIdleSessionToHistory(sessionId: string): boolean {
    const session = this.store.getSession(sessionId)
    if (!session || session.closedAt || session.mode !== 'claude-code') return false
    if (
      this.live.has(sessionId) ||
      this.connecting.has(sessionId) ||
      this.creatingWorktree.has(sessionId) ||
      this.startupAutoReconnect.has(sessionId)
    ) {
      return false
    }
    if (this.getStatus(sessionId) !== 'startup-idle') return false
    void this.closeSession(sessionId)
    return true
  }

  private sendStatus(sessionId: string): void {
    if (this.maybeAutoCloseIdleSessionToHistory(sessionId)) return
    this.getWindow()?.webContents.send('session:status', { sessionId, status: this.getStatus(sessionId) })
  }

  /**
   * Pushes the composer's Send/Stop toggle state (04-composer-core). `true`
   * from the moment a turn is kicked off (initial prompt, a follow-up via
   * `sendUserMessage`, or streamed live into an in-flight turn) until its
   * terminal harness event (`result`/`interrupted`/`error`) is applied —
   * independent of `HarnessDriver.isActive`, which now (see `normalize()`'s
   * fix in this task) stays true across idle gaps between turns too and so
   * can no longer be used as a busy signal on its own.
   */
  private sendTurnState(sessionId: string, busy: boolean): void {
    this.getWindow()?.webContents.send('session:turnState', { sessionId, busy })
    if (!busy) this.clearInFlightSdkChrome(sessionId)
  }

  private beginPendingUserTurn(sessionId: string, userMessageId: number): void {
    let live = this.live.get(sessionId)
    if (!live) {
      live = newLiveStream()
      this.live.set(sessionId, live)
    }
    live.pendingUserMessageId = userMessageId
    live.turnExecutionStarted = false
    live.interruptRequested = false
  }

  private markTurnExecutionStarted(live: LiveStream): void {
    if (live.turnExecutionStarted) return
    live.turnExecutionStarted = true
  }

  private clearPendingUserTurn(live: LiveStream): void {
    live.pendingUserMessageId = null
    live.turnExecutionStarted = false
  }

  /**
   * Live slash-command registry push (bug #56) — see `SessionCommandsEvent`'s
   * doc comment (shared/session-types.ts). Fired once shortly after
   * start/resume (from the harness's `commands_updated` event, itself
   * sourced from the SDK's `query.initializationResult()`) and again on any
   * mid-session `commands_changed` push from the SDK. Always the FULL
   * replacement list — never a delta.
   */
  private sendWorktreeProgress(sessionId: string, percent: number): void {
    this.getWindow()?.webContents.send('session:worktreeProgress', { sessionId, percent })
  }

  private sendTokenUsage(sessionId: string, inputTokens: number, contextWindow: number): void {
    this.getWindow()?.webContents.send('session:tokenUsage', { sessionId, inputTokens, contextWindow })
  }

  private sendPromptSuggestion(sessionId: string, suggestion: string | null): void {
    this.getWindow()?.webContents.send('session:promptSuggestion', { sessionId, suggestion })
  }

  private sendBackgroundTasks(sessionId: string): void {
    const payload: SessionBackgroundTasksEvent = {
      sessionId,
      tasks: this.harnessUi.getTasks(sessionId),
    }
    this.getWindow()?.webContents.send('session:backgroundTasks', payload)
  }

  private sendSdkChrome(sessionId: string): void {
    const chrome = this.harnessUi.getSdkChrome(sessionId)
    const payload: SessionSdkChromeEvent = {
      sessionId,
      status: chrome?.compactFailed ? null : (chrome?.status ?? null),
      permissionMode: chrome?.permissionMode,
      compactFailed: chrome?.compactFailed,
      compactError: chrome?.compactError,
      apiRetryText: chrome?.apiRetryText ?? null,
      thinkingActive: chrome?.thinkingActive,
      thinkingEstimatedTokens: chrome?.thinkingEstimatedTokens,
    }
    this.getWindow()?.webContents.send('session:sdkChrome', payload)
  }

  private clearInFlightSdkChrome(sessionId: string): void {
    this.harnessUi.clearInFlightStatus(sessionId)
    this.sendSdkChrome(sessionId)
  }

  private sendRateLimitChrome(sessionId: string): void {
    const rl = this.harnessUi.getRateLimit(sessionId)
    const payload: SessionRateLimitEvent = {
      sessionId,
      warnLabel: rl?.warnLabel ?? null,
      sendBlocked: rl?.sendBlocked ?? false,
    }
    this.getWindow()?.webContents.send('session:rateLimit', payload)
  }

  private sendSdkToast(sessionId: string, toast: SessionToastEvent): void {
    this.getWindow()?.webContents.send('session:sdkToast', toast)
  }

  private sendAuthStatus(): void {
    const auth = this.harnessUi.getAuth()
    const payload: SessionAuthStatusEvent = {
      message: auth.message,
      isAuthenticating: auth.isAuthenticating,
    }
    this.getWindow()?.webContents.send('session:authStatus', payload)
  }

  private resetHarnessUiForSession(sessionId: string): void {
    this.harnessUi.resetSession(sessionId)
    this.sendBackgroundTasks(sessionId)
    this.sendSdkChrome(sessionId)
    this.sendRateLimitChrome(sessionId)
  }

  private applyHarnessUiSideEffects(sessionId: string, event: HarnessEvent): void {
    const uiTypes = new Set([
      'background_tasks_changed',
      'task_started',
      'task_updated',
      'task_progress',
      'task_notification',
      'sdk_notification',
      'sdk_status',
      'api_retry',
      'rate_limit_event',
      'auth_status',
      'hook_started',
      'hook_progress',
      'hook_response',
      'worker_shutting_down',
    ])
    if (!uiTypes.has(event.type)) return
    const side = this.harnessUi.apply(event)
    this.sendBackgroundTasks(sessionId)
    this.sendSdkChrome(sessionId)
    this.sendRateLimitChrome(sessionId)
    if (event.type === 'auth_status') this.sendAuthStatus()
    if (side.toast) {
      this.sendSdkToast(sessionId, { sessionId, ...side.toast })
    }
    if (side.logHook) {
      logger.info('harness hook', { sessionId, line: side.logHook })
      this.getWindow()?.webContents.send('session:hookLog', { sessionId, line: side.logHook })
    }
  }

  private sendCommands(sessionId: string, commands: SlashCommandInfo[]): void {
    this.getWindow()?.webContents.send('session:commands', { sessionId, commands })
  }

  private sendModels(sessionId: string, models: ModelInfo[]): void {
    this.getWindow()?.webContents.send('session:models', { sessionId, models })
  }

  private sendHarnessCwd(sessionId: string, cwd: string): void {
    this.getWindow()?.webContents.send('session:harnessCwd', { sessionId, cwd })
  }

  /**
   * Local `child_process.spawn()` requires a real filesystem cwd — a literal
   * `~` makes spawn fail with ENOENT (surfacing as the SDK's misleading
   * "native binary … failed to launch" error). Remote sessions keep `~` as
   * typed; `remoteCdTarget()` expands it inside the SSH command.
   */
  private resolveHarnessCwd(
    projectPath: string,
    hostname: string | null | undefined,
    worktreePath?: string | null,
  ): string {
    const raw = worktreePath ?? projectPath
    if (hostname) return raw
    return expandTildePath(raw, homedir())
  }

  /**
   * Harness options that tell a worktree-backed session where its boundary is.
   * `cwd` alone doesn't hold the agent inside the worktree — it can still
   * reach the original checkout by absolute path (and has: see
   * `worktreeSystemPromptAppend`'s doc comment), which silently strands the
   * work outside the Diff panel's view. Empty for sessions without a
   * worktree, so their system prompt stays exactly as it is today.
   */
  private worktreeHarnessOpts(
    projectPath: string,
    worktreePath: string | null | undefined,
    homeDir: string
  ): { appendSystemPrompt?: string } {
    if (!worktreePath) return {}
    return {
      appendSystemPrompt: worktreeSystemPromptAppend(
        expandTildePath(worktreePath, homeDir),
        expandTildePath(projectPath, homeDir)
      )
    }
  }

  private resolveHost(hostId: string): RemoteHost | undefined {
    if (hostId === 'local') return undefined
    const host = this.hosts.resolve(hostId)
    if (!host) throw new Error(`Unknown host id: ${hostId}`)
    return { sshHost: host.sshHost, remoteExecutablePath: host.remoteExecutablePath }
  }

  /**
   * Re-derives a RemoteHost (including remoteExecutablePath) from a stored
   * session's `hostname` column alone. Sessions only persist the SSH
   * hostname string, not the full host-option record, so resume/reconnect/
   * auto-naming all have to look it back up by hostname rather than reusing
   * a stale `{ sshHost }`-only object (which previously dropped
   * remoteExecutablePath on every path except the initial create, breaking
   * remote sessions with a bare, unresolvable `claude` on PATH after the
   * first turn).
   */
  private resolveHostFromSession(hostname: string | null): RemoteHost | undefined {
    if (!hostname) return undefined
    const host = this.hosts.resolveByHostname(hostname)
    return { sshHost: hostname, remoteExecutablePath: host?.remoteExecutablePath }
  }

  private homeDirForStoredSession(session: SessionRecord): string {
    const host = session.hostname ? this.hosts.resolveByHostname(session.hostname) : undefined
    return homeDirForWorktreeHost(host?.id ?? 'local')
  }

  /** Remove a session's git worktree (and branch) and clear `worktree_path` in SQLite. */
  private async cleanupSessionWorktree(
    session: SessionRecord,
    opts?: { clearStoredPath?: boolean }
  ): Promise<void> {
    const hostname = session.hostname ? this.hosts.resolveByHostname(session.hostname)?.sshHost : undefined
    const homeDir = this.homeDirForStoredSession(session)
    const worktreeRoot = worktreeRootFromConfig(loadConfig())
    const paths = new Set<string>()
    if (session.worktreePath) paths.add(session.worktreePath)
    paths.add(sessionWorktreePath(worktreeRoot, session.id, homeDir))
    for (const worktreePath of paths) {
      try {
        await removeWorktree(worktreePath, session.id, session.projectPath, homeDir, hostname)
      } catch (err) {
        logger.warn('cleanupSessionWorktree: removal failed (ignored)', {
          sessionId: session.id,
          worktreePath,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (opts?.clearStoredPath !== false && session.worktreePath) {
      const stillExists = await worktreePathExists(session.worktreePath, hostname)
      if (!stillExists) {
        this.store.setWorktreePath(session.id, null)
      } else {
        logger.warn('cleanupSessionWorktree: worktree still present after removal attempt — keeping worktree_path', {
          sessionId: session.id,
          worktreePath: session.worktreePath
        })
      }
    }
  }

  /**
   * After Close mistakenly cleared `worktree_path` (or a failed remote remove
   * left the checkout on disk), re-bind the session to its expected worktree
   * directory so Reconnect resumes in the right cwd.
   */
  private async ensureSessionWorktreePath(session: SessionRecord): Promise<SessionRecord> {
    if (session.worktreePath) return session
    if (this.worktreeMissingChecked.has(session.id)) return session
    const homeDir = this.homeDirForStoredSession(session)
    const worktreeRoot = worktreeRootFromConfig(loadConfig())
    const expected = sessionWorktreePath(worktreeRoot, session.id, homeDir)
    const hostname = session.hostname ? this.hosts.resolveByHostname(session.hostname)?.sshHost : undefined
    if (!(await worktreePathExists(expected, hostname))) {
      this.worktreeMissingChecked.add(session.id)
      return session
    }
    logger.info('ensureSessionWorktreePath: re-binding orphan worktree directory', {
      sessionId: session.id,
      worktreePath: expected
    })
    this.store.setWorktreePath(session.id, expected)
    const updated = this.decorate(this.store.getSession(session.id)!)
    this.sendLifecycle({ type: 'session.updated', session: updated })
    this.sendHarnessCwd(session.id, expected)
    return updated
  }

  // ── Create ──────────────────────────────────────────────────────────

  private defaultModelSelection(): ModelSelection {
    const cfg = loadConfig()
    return {
      model: defaultClaudeModelFromConfig(cfg),
      effort: defaultClaudeEffortFromConfig(cfg)
    }
  }

  private defaultHarnessModelOpts(): Pick<HarnessStartOptions, 'model' | 'effort'> {
    const { model, effort } = this.defaultModelSelection()
    return { model, effort }
  }

  private seedDefaultModelSelection(sessionId: string): void {
    const selection = this.defaultModelSelection()
    this.modelSelections.set(sessionId, selection)
    this.store.setModelSelection(sessionId, selection)
  }

  private resolveInitialPermissionMode(opts: CreateSessionOptions): PermissionModeValue {
    if (opts.planMode) return 'plan'
    return defaultClaudePermissionModeFromConfig(loadConfig())
  }

  private seedInitialPermissionMode(sessionId: string, mode: PermissionModeValue): void {
    if (mode === 'default') return
    this.permissionModes.set(sessionId, mode)
    this.store.setPermissionMode(sessionId, mode)
  }

  private permissionModeHarnessOpts(mode: PermissionModeValue): Pick<HarnessStartOptions, 'permissionMode'> {
    return mode === 'default' ? {} : { permissionMode: mode }
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionRecord> {
    const host = this.resolveHost(opts.hostId)
    const hostOption = opts.hostId === 'local' ? undefined : this.hosts.resolve(opts.hostId)
    const defaultName = deriveDefaultName(opts.projectPath, opts.prompt)

    // fix-bug-triage-jul31 / bug #49: remember this path was used for this
    // host, so the New Session modal can offer it again later even after
    // the modal's own state resets on reopen. Recorded once host resolution
    // above has already succeeded (an unknown hostId throws before this
    // point), so we never record a path against a host id that doesn't exist.
    this.store.recordProjectPathUsage(opts.hostId, opts.projectPath)

    if (opts.mode === 'terminal') {
      // Terminal-only sessions have no agent/harness involvement in this task
      // (real pty/shell integration is a later feature) — just a row so it
      // shows up in the sidebar and can be closed/renamed/deleted like any
      // other session.
      const session = this.store.createSession({
        name: opts.suggestedName?.trim() || deriveDefaultName(opts.projectPath, opts.prompt),
        projectPath: opts.projectPath,
        mode: 'terminal',
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null,
        profileId: opts.profileId ?? null
      })
      this.sendLifecycle({ type: 'session.created', session })
      if (session.hostname) void warmRemoteGitHost(session.hostname)
      return session
    }

    // use-worktree: create an isolated git worktree for claude-code sessions
    // (local or remote/devpod) when the user opted in. We pre-allocate the
    // session id (so the worktree path can embed it) and use harness.startWithId()
    // instead of harness.start(). Worktree creation runs asynchronously after
    // the session row is visible in the sidebar (creating-worktree state).
    let effectiveCwd = this.resolveHarnessCwd(opts.projectPath, hostOption?.sshHost ?? null)
    const wantWorktree = !!opts.useWorktree
    const hostname = hostOption?.sshHost

    if (wantWorktree) {
      const { randomUUID } = await import('node:crypto')
      const allocatedId = randomUUID()
      const permissionMode = this.resolveInitialPermissionMode(opts)

      // Create the session record immediately (worktreePath will be filled in
      // once the async worktree creation succeeds) and broadcast
      // session:created so the modal can close and the sidebar row appears.
      const session = this.decorate(
        this.store.createSession({
          id: allocatedId,
          name: defaultName,
          projectPath: opts.projectPath,
          mode: 'claude-code',
          hostname: hostOption?.sshHost ?? null,
          groupId: opts.groupId ?? null,
          worktreePath: null,
          profileId: opts.profileId ?? null
        })
      )
      this.seedDefaultModelSelection(allocatedId)
      this.seedInitialPermissionMode(allocatedId, permissionMode)

      // Mark as 'creating-worktree' BEFORE session:created so the renderer's
      // first paint of the new row already has the pending status/progress UI.
      this.creatingWorktree.add(allocatedId)
      this.sendStatus(allocatedId)

      this.sendLifecycle({ type: 'session.created', session })
      if (session.hostname) void warmRemoteGitHost(session.hostname)

      // Fire worktree creation + harness start asynchronously so createSession
      // returns immediately (the modal closes, the row appears).
      void this.setupWorktreeAsync(allocatedId, opts, host, hostOption, hostname, permissionMode)

      return session
    }

    const permissionMode = this.resolveInitialPermissionMode(opts)
    const harnessSession = await this.harness.start(opts.prompt ?? '', {
      cwd: effectiveCwd,
      host,
      // Real interactive chat session: stays connected past its first turn
      // so a later `sendUserMessage` can inject live via `streamInput()`
      // instead of always reconnecting — see `HarnessStartOptions.keepAlive`.
      keepAlive: true,
      ...this.defaultHarnessModelOpts(),
      ...this.permissionModeHarnessOpts(permissionMode)
    })
    if (permissionMode !== 'default') {
      this.seedInitialPermissionMode(harnessSession.sessionId, permissionMode)
    }

    const session = this.decorate(
      this.store.createSession({
        id: harnessSession.sessionId,
        name: defaultName,
        projectPath: opts.projectPath,
        mode: 'claude-code',
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null,
        worktreePath: null,
        profileId: opts.profileId ?? null
      })
    )

    if (opts.prompt) {
      const userMessage = this.store.addMessage({ sessionId: session.id, role: 'user', content: opts.prompt })
      this.sendMessage(session.id, userMessage)
      this.beginPendingUserTurn(session.id, userMessage.id)
    }

    this.seedDefaultModelSelection(session.id)
    this.live.set(session.id, newLiveStream())
    this.resetHarnessUiForSession(session.id)
    this.pendingPanelPreload.add(session.id)
    if (session.mode === 'claude-code') {
      this.connecting.add(session.id)
      if (!opts.prompt) {
        this.sendStatus(session.id)
      }
    }
    // A real turn is about to run only if there's an initial prompt to
    // process — an empty-prompt create just opens the connection.
    if (opts.prompt) {
      this.live.get(session.id)!.busy = true
      this.sendStatus(session.id)
      this.sendTurnState(session.id, true)
    }
    void this.consume(session.id, harnessSession.events, this.bumpConsumeGeneration(session.id))

    // Broadcast only after live/consume are wired so a renderer resume/reconnect
    // triggered by this event cannot race a second harness start for the same id.
    this.sendLifecycle({ type: 'session.created', session })
    if (session.hostname) void warmRemoteGitHost(session.hostname)
    return session
  }

  // ── Resume ──────────────────────────────────────────────────────────

  /**
   * Async worktree setup for `createSession` (use-worktree): runs after the
   * session record has already been created and `session:created` has been
   * broadcast so the sidebar row is visible in the 'creating-worktree' state.
   * On success: persists the worktree path, removes the 'creating-worktree'
   * flag, starts the harness, and transitions the row to its live status.
   * On failure: cleans up partial worktree state, keeps the session row, and
   * surfaces a system error in the transcript (no silent delete).
   */
  private async setupWorktreeAsync(
    sessionId: string,
    opts: CreateSessionOptions,
    host: RemoteHost | undefined,
    hostOption: RemoteHostOption | undefined,
    hostname: string | undefined,
    permissionMode: PermissionModeValue
  ): Promise<void> {
    try {
      const cfg = loadConfig()
      const worktreeRoot = worktreeRootFromConfig(cfg)
      const homeDir = homeDirForWorktreeHost(opts.hostId)
      const worktreePath = await createWorktree(
        opts.projectPath,
        sessionId,
        worktreeRoot,
        homeDir,
        hostname,
        (pct) => {
          this.sendWorktreeProgress(sessionId, pct)
        }
      )
      const afterCreate = this.store.getSession(sessionId)
      if (!afterCreate || afterCreate.closedAt || afterCreate.deletedAt) {
        logger.info('setupWorktreeAsync: session closed or deleting during worktree creation — cleaning up', { sessionId })
        void removeWorktree(
          worktreePath,
          sessionId,
          opts.projectPath,
          homeDir,
          hostname
        ).catch(() => undefined)
        if (afterCreate?.worktreePath) this.store.setWorktreePath(sessionId, null)
        return
      }
      logger.info('setupWorktreeAsync: worktree created', { sessionId, worktreePath })

      // Persist the worktree path now that we have it.
      this.store.setWorktreePath(sessionId, worktreePath)
      const withWorktree = this.decorate(this.store.getSession(sessionId)!)
      this.sendLifecycle({ type: 'session.updated', session: withWorktree })
      this.sendHarnessCwd(sessionId, worktreePath)
      if (this.workspace) void this.workspace.refreshWorkspace(withWorktree, true, { includeFiles: true })

      const harnessOpts = {
        cwd: worktreePath,
        host,
        keepAlive: true as const,
        ...this.defaultHarnessModelOpts(),
        ...this.permissionModeHarnessOpts(permissionMode),
        ...this.worktreeHarnessOpts(opts.projectPath, worktreePath, homeDir)
      }
      const harnessSession = await this.harness.startWithId(sessionId, opts.prompt ?? '', harnessOpts)

      if (opts.prompt) {
        const userMessage = this.store.addMessage({ sessionId, role: 'user', content: opts.prompt })
        this.sendMessage(sessionId, userMessage)
        this.beginPendingUserTurn(sessionId, userMessage.id)
      }

      // Remove creating-worktree state and transition to live.
      this.creatingWorktree.delete(sessionId)
      this.live.set(sessionId, newLiveStream())
      this.resetHarnessUiForSession(sessionId)
      this.pendingPanelPreload.add(sessionId)
      this.connecting.add(sessionId)
      if (opts.prompt) {
        this.live.get(sessionId)!.busy = true
      }
      this.sendStatus(sessionId)
      if (opts.prompt) this.sendTurnState(sessionId, true)
      void this.consume(sessionId, harnessSession.events, this.bumpConsumeGeneration(sessionId))
    } catch (err) {
      logger.warn('setupWorktreeAsync: failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      const wasCreatingWorktree = this.creatingWorktree.has(sessionId)
      this.creatingWorktree.delete(sessionId)
      const stored = this.store.getSession(sessionId)
      if (stored && (stored.worktreePath || wasCreatingWorktree)) {
        await this.cleanupSessionWorktree(stored, { clearStoredPath: !!stored.worktreePath })
      }
      this.reportHarnessFailure(sessionId, 'worktree setup', err)
      const session = this.store.getSession(sessionId)
      if (session) {
        this.sendLifecycle({ type: 'session.updated', session: this.decorate(session) })
      }
    }
  }

  /** Reopens a closed session and returns it + the display-window transcript (renderer renders this BEFORE the live reconnect below happens). */
  resumeSnapshot(sessionId: string): SessionMessagesResult & { session: SessionRecord } {
    const existing = this.store.getSession(sessionId)
    if (!existing) throw new Error(`Unknown session: ${sessionId}`)
    const session = this.decorate(this.store.reopenSession(sessionId) ?? existing)
    this.finalizeStaleRunningToolCalls(sessionId)
    this.deliverPendingTurnInterruptedNotice(sessionId)
    const display = this.store.listMessagesForDisplay(sessionId)
    this.sendLifecycle({ type: 'session.resumed', session })
    return { session, ...display }
  }

  /**
   * Shared reconnect dispatch (fix-no-conversation-found-remote-resume):
   * every call site that used to unconditionally call `harness.resume()`
   * (`reconnect()`'s explicit resume-button path, and `sendUserMessage()`'s
   * "no live harness session" fallback) funnels through here now. A
   * `--resume <id>` reconnect is only valid for a session id the underlying
   * CLI has ACTUALLY recorded a real conversation for — `SessionRecord.
   * everConnected` (persisted, set the moment this session's very first
   * `session_started` harness event ever fired) is the ground truth for
   * that, not merely "does `SessionManager` have local state that looks
   * active." A session that's never gotten that far (e.g. created with no
   * initial prompt, then closed/interrupted, or whose earlier attempts all
   * failed before ever completing the CLI's init handshake) gets routed
   * through `harness.startWithId()` instead — a genuinely fresh conversation
   * as far as the CLI is concerned, just one that reuses the id Atelier
   * already fixed in its own SQLite row, so the rest of the app (transcript,
   * IPC, etc.) never needs to know the id changed, because it doesn't.
   */
  private async reconnectHarness(
    session: SessionRecord,
    opts: { permissionMode?: PermissionModeValue; model?: string; effort?: ModelSelection['effort']; initialPrompt?: string }
  ): Promise<HarnessSession> {
    const host = this.resolveHostFromSession(session.hostname)
    const startOpts = {
      cwd: this.resolveHarnessCwd(session.projectPath, session.hostname, session.worktreePath),
      host,
      keepAlive: true,
      ...this.worktreeHarnessOpts(
        session.projectPath,
        session.worktreePath,
        this.homeDirForStoredSession(session)
      ),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {})
    }
    const sdkSessionId = this.store.getSdkSessionId(session.id)
    if (!session.everConnected) {
      logger.info('reconnectHarness: session never had a real connection, starting fresh (not resume())', {
        sessionId: session.id
      })
      return {
        sessionId: session.id,
        events: this.startFreshWithRetry(session, startOpts, opts.initialPrompt)
      }
    }
    const harnessSession = await this.harness.resume(session.id, {
      ...startOpts,
      resumeSessionId: sdkSessionId
    })
    return {
      sessionId: harnessSession.sessionId,
      events: this.withConversationLostFallback(session, startOpts, harnessSession.events)
    }
  }

  /**
   * fix-remote-resume-conversation-lost-fallback: a session with
   * `everConnected === true` genuinely did connect once, but the CLI backend
   * (local or remote/devpod) can still have since lost ALL record of that
   * conversation — a devpod restart/disk-clear pruning its own history, or
   * (verified locally as a faithful reproduction, same error text and exit
   * code) the session's own transcript file having been deleted. `resume()`
   * against that fails with "No conversation found with session ID: ..." on
   * EVERY future attempt forever — there is no local flag that can predict
   * this in advance, so it can only be detected by actually trying `resume()`
   * and watching for this specific failure in the harness's own event
   * stream (see claude-agent-sdk-harness.ts's `launch()`/`pump()`: a lost
   * conversation first yields a `result` event with `isError: true` — handled
   * silently by `applyEvent`'s `case 'result':`, nothing to intercept there —
   * then the very next `query.next()` throws, which `pump()`'s `catch` turns
   * into a `type: 'error'` event with this exact message).
   *
   * On seeing that specific error (and ONLY on the first occurrence for this
   * reconnect attempt — this generator returns right after, so there is no
   * loop), this swallows the raw/confusing CLI error, persists a plain-
   * language system message explaining what happened, and falls back ONCE to
   * `startWithId()` — a genuinely fresh conversation reusing the same session
   * id (same mechanism `!session.everConnected` already uses above) — then
   * re-yields THAT session's events for the remainder of this generator's
   * life. If the fallback itself throws, no further retry is attempted: a
   * distinct `error` event is yielded instead, which `applyEvent`'s existing
   * `case 'error':` persists as a normal visible system error — so the user
   * always reaches a clear terminal state.
   *
   * Any OTHER `error` event (bad cwd, auth failure, network — anything not
   * matching this specific message) passes through completely unchanged,
   * preserving the "a genuine reconnect failure still surfaces an error"
   * behavior already covered by `session-lifecycle.spec.ts`'s "bug repro
   * safety net" test.
   */
  private async *withConversationLostFallback(
    session: SessionRecord,
    startOpts: { cwd: string; host?: RemoteHost; keepAlive: boolean; permissionMode?: PermissionModeValue; model?: string; effort?: ModelSelection['effort']; appendSystemPrompt?: string },
    events: AsyncGenerator<HarnessEvent, void, void>
  ): AsyncGenerator<HarnessEvent, void, void> {
    for await (const event of events) {
      if (event.type === 'error' && isConversationLostError(event.message)) {
        logger.warn('reconnectHarness: resume() failed because the CLI has lost this conversation server-side; falling back once to a fresh session reusing the same id', {
          sessionId: session.id,
          error: event.message
        })
        const notice = this.store.addMessage({
          sessionId: session.id,
          role: 'system',
          content:
            'Reconnecting lost the server-side conversation history for this session (likely due to a remote restart or history being cleared). Starting fresh with the same session — prior messages are still visible above, but the assistant will not have that context anymore.'
        })
        this.sendMessage(session.id, notice)
        try {
          yield* this.startFreshWithRetry(session, startOpts)
        } catch (err) {
          yield {
            type: 'error',
            sessionId: session.id,
            timestamp: new Date().toISOString(),
            message: `Fallback to a fresh session also failed: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        return
      }
      yield event
    }
  }

  /**
   * Starts a fresh `startWithId()` conversation, with a SHORT, BOUNDED
   * exponential-backoff retry (max 4 total attempts, ~1.5s/3s/5s delays —
   * never unbounded/forever) if — and only if — the CLI reports the exact
   * `"Session ID ... is already in use"` conflict. Verified for real
   * (SDK-level probe, driven through the same persistent streaming-input
   * `query()` shape `claude-agent-sdk-harness.ts` actually uses — a plain
   * sequential one-shot `-p` CLI probe never reproduced this at all) that
   * this is a genuine, narrow race, not a design flaw in falling back at
   * all: `SessionManager`'s live sessions use a persistent streaming-input
   * queue (`keepAlive: true`), so the FAILED resume's underlying `query()`
   * still held session-level state that the SDK itself hadn't released yet
   * at the exact moment the fallback's new `startWithId()` call tries to
   * reuse that same id — `pump()`'s catch (claude-agent-sdk-harness.ts) now
   * also calls `query.interrupt()` on a genuine (non-self-inflicted) failure
   * specifically to release that state sooner, but the backoff here remains
   * as a bounded safety net since that call is fire-and-forget (not awaited
   * before the fallback's own retry loop proceeds). Any OTHER error, or the
   * SAME conflict still happening after all attempts are exhausted, is
   * surfaced normally (via the plain `'error'`/`'result'` events
   * `fresh.events` naturally yields) — this loop is capped, so it still
   * can't retry forever.
   */
  private async *startFreshWithRetry(
    session: SessionRecord,
    startOpts: { cwd: string; host?: RemoteHost; keepAlive: boolean; permissionMode?: PermissionModeValue; model?: string; effort?: ModelSelection['effort']; appendSystemPrompt?: string },
    initialPrompt?: string
  ): AsyncGenerator<HarnessEvent, void, void> {
    const MAX_ATTEMPTS = 4
    const RETRY_DELAYS_MS = [1500, 3000, 5000]
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fresh = await this.harness.startWithId(session.id, initialPrompt ?? '', {
        ...startOpts,
        cliSessionId: this.store.getSdkSessionId(session.id)
      })
      const iterator = fresh.events[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done) return
      const canRetry = attempt < MAX_ATTEMPTS
      if (canRetry && first.value.type === 'error' && isSessionLockRaceError(first.value.message)) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1]
        logger.warn('startFreshWithRetry: hit a transient session-id lock race right after the failed resume; retrying after a short delay', {
          sessionId: session.id,
          attempt,
          delayMs,
          error: first.value.message
        })
        await delay(delayMs)
        continue
      }
      yield first.value
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    }
  }

  /** Reconnects the live harness session on top of the already-rendered transcript. No-op for terminal sessions. */
  async reconnect(sessionId: string): Promise<void> {
    let session = this.store.getSession(sessionId)
    if (!session || session.mode !== 'claude-code') return
    session = await this.ensureSessionWorktreePath(session)
    // Don't race with setupWorktreeAsync — while the worktree is being created
    // the harness will be started by that path once creation completes.
    if (this.creatingWorktree.has(sessionId)) return
    if (this.connecting.has(sessionId)) return
    // Already live (e.g. connected by createSession or startupReconnect) — resync ephemeral UI.
    if (this.live.has(sessionId) || this.harness.isActive(sessionId)) {
      this.sendBackgroundTasks(sessionId)
      this.sendSdkChrome(sessionId)
      this.sendRateLimitChrome(sessionId)
      return
    }
    this.startupIdle.delete(sessionId)
    this.touchLastActive(sessionId)
    this.pendingPanelPreload.add(sessionId)
    // Fix (fix-session-resume-stale-sigterm-and-no-connect-indicator): mark
    // this session as 'connecting' for the topbar's "Connecting…" pill for
    // the whole gap between triggering this reconnect and the harness
    // actually being (re)established below — cleared in both the success
    // and failure paths so the pill never gets stuck visible.
    this.connecting.add(sessionId)
    this.sendStatus(sessionId)
    try {
      this.finalizeStaleRunningToolCalls(sessionId)
      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? undefined
      const harnessSession = await this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort
      })
      // closeSession()/restartSession() can invalidate this session while
      // reconnectHarness() is awaiting SDK/SSH setup. Never resurrect live
      // state for a row that was closed or atomically replaced in that gap.
      const currentSession = this.store.getSession(sessionId)
      if (!currentSession || currentSession.closedAt) {
        this.connecting.delete(sessionId)
        this.pendingPanelPreload.delete(sessionId)
        this.workspacePreloadInFlight.delete(sessionId)
        void this.harness.interrupt(sessionId).catch(() => undefined)
        return
      }
      // NOT cleared here — `harness.resume()` resolving only means the SDK
      // `query()` call was constructed, not that the subprocess has handshaken.
      // `connecting` stays until this session's workspace preload finishes
      // (or times out) in `applyEvent()` → `completeSessionOpen()`.
      this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)))
      this.resetHarnessUiForSession(sessionId)
      this.sendStatus(sessionId)
      void this.consume(sessionId, harnessSession.events, this.bumpConsumeGeneration(sessionId))
    } catch (err) {
      this.connecting.delete(sessionId)
      this.pendingPanelPreload.delete(sessionId)
      this.workspacePreloadInFlight.delete(sessionId)
      // A genuine reconnect failure must still surface distinctly — this is
      // unrelated to Part A's fix above (which only suppresses the bogus
      // error a graceful CLOSE causes); reportHarnessFailure logs it AND
      // persists a visible system-role error message, same as before.
      this.reportHarnessFailure(sessionId, 'reconnect', err)
      throw err
    }
  }

  // ── Send message into a live (or reconnected) session ──────────────

  /** Full message payload kept in the main-process turn queue (superset of the IPC-visible PendingQueuedMessage). */
  private makeQueuedEntry(text: string, attachments?: FileAttachment[], modelOverride?: ModelSelection, userMessageId?: number): QueueEntry {
    return {
      id: randomUUID(),
      text,
      attachments,
      modelOverride,
      userMessageId: userMessageId ?? null,
    }
  }

  private getOrCreateTurnQueue(sessionId: string): { items: QueueEntry[]; inflightId: string | null } {
    let q = this.turnQueues.get(sessionId)
    if (!q) {
      q = { items: [], inflightId: null }
      this.turnQueues.set(sessionId, q)
    }
    return q as { items: QueueEntry[]; inflightId: string | null }
  }

  private sendQueueState(sessionId: string): void {
    const q = this.turnQueues.get(sessionId)
    const items: PendingQueuedMessage[] = (q?.items ?? []).map((item) => ({ id: item.id, text: item.text }))
    this.getWindow()?.webContents.send('session:queueUpdated', { sessionId, items })
  }

  /** Remove all pending (non-inflight) items from the queue and notify the renderer. */
  private clearTurnQueue(sessionId: string): void {
    const q = this.turnQueues.get(sessionId)
    if (!q) return
    q.items = []
    q.inflightId = null
    this.sendQueueState(sessionId)
  }

  cancelQueued(sessionId: string, id: string): void {
    const q = this.turnQueues.get(sessionId)
    if (!q) return
    q.items = q.items.filter((item) => item.id !== id)
    this.sendQueueState(sessionId)
    logger.info('turnQueue: cancelled queued message', { sessionId, id })
  }

  /**
   * Drain the next pending message from the turn queue after a turn completes.
   * Returns true if a new turn was dispatched (caller should NOT call
   * sendTurnState(false) in that case — dispatchTurnToHarness does it).
   */
  private drainTurnQueue(sessionId: string): boolean {
    const q = this.turnQueues.get(sessionId)
    if (!q || q.items.length === 0) {
      if (q) q.inflightId = null
      return false
    }
    const next = q.items.shift()!
    q.inflightId = next.id
    this.sendQueueState(sessionId)
    logger.info('turnQueue: draining next queued message', { sessionId, id: next.id })
    void this.dispatchTurnToHarness(sessionId, next).catch((err) => {
      this.reportHarnessFailure(sessionId, 'drainTurnQueue', err)
    })
    return true
  }

  /**
   * Actual harness dispatch for one queued turn. Mirrors the former body of
   * `sendUserMessage` from `beginPendingUserTurn` onward. Safe to call for
   * both immediately-dispatched (inflightId already set) and drain-triggered
   * messages.
   */
  private async dispatchTurnToHarness(
    sessionId: string,
    item: QueueEntry,
  ): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return
    const { text, attachments, modelOverride } = item
    // Deferred message (was queued while another turn was inflight): add to
    // the DB and show in chat now, just before dispatching, so the message
    // appears in the transcript at the right moment rather than when typed.
    let resolvedMessageId = item.userMessageId
    if (resolvedMessageId == null) {
      const content: string = attachments?.length
        ? JSON.stringify({ kind: 'files_attachment', files: attachments.map(({ mimeType, data, name }) => ({ mimeType, data, name })), text } satisfies FilesAttachmentContent)
        : text
      const userMessage = this.store.addMessage({ sessionId, role: 'user', content })
      this.sendMessage(sessionId, userMessage)
      resolvedMessageId = userMessage.id
    }
    if (resolvedMessageId != null) this.beginPendingUserTurn(sessionId, resolvedMessageId)
    this.sendTurnState(sessionId, true)
    try {
      const previousSelection = this.modelSelections.get(sessionId)
      const selectionChanged = modelOverride !== undefined && !modelSelectionsEqual(modelOverride, previousSelection)
      if (selectionChanged) {
        logger.info('dispatchTurnToHarness: model/effort selection changed, applying from next turn', {
          sessionId,
          previous: previousSelection,
          next: modelOverride
        })
        this.modelSelections.set(sessionId, modelOverride)
        this.store.setModelSelection(sessionId, modelOverride)
        if (this.harness.isActive(sessionId)) {
          await this.harness.interrupt(sessionId)
        }
      }

      // NOTE: `harness.isActive()` can still report `true` immediately after
      // the `interrupt()` above — the underlying session map entry is only
      // cleared once `pump()`'s `finally` block finishes draining (see
      // claude-agent-sdk-harness.ts), which is asynchronous and hasn't
      // necessarily run yet by the time `interrupt()`'s own promise
      // resolves. Checking `isActive()` again here would then wrongly take
      // the streamInput fast path against a queue that's already `closed`
      // (queue.push() on a closed UserMessageQueue silently no-ops) — a real
      // bug caught here during this task: the message would vanish with no
      // error and the turn would hang forever, Stop button stuck. So a
      // `selectionChanged` reconnect ALWAYS falls through to the `resume()`
      // path below, regardless of what `isActive()` reports afterward.
      if (!selectionChanged && this.harness.isActive(sessionId)) {
        logger.info('dispatchTurnToHarness: live injection (streamInput, no resume)', { sessionId })
        await this.harness.streamInput(sessionId, text, attachments)
        const liveEntry = this.live.get(sessionId)
        if (liveEntry) {
          liveEntry.busy = true
          this.sendStatus(sessionId)
        }
        return
      }
      if (this.connecting.has(sessionId)) {
        await this.waitUntilNotConnecting(sessionId)
        if (!selectionChanged && this.harness.isActive(sessionId)) {
          logger.info('dispatchTurnToHarness: live injection after reconnect wait (streamInput)', { sessionId })
          await this.harness.streamInput(sessionId, text, attachments)
          const liveEntry = this.live.get(sessionId)
          if (liveEntry) {
            liveEntry.busy = true
            this.sendStatus(sessionId)
          }
          return
        }
      }
      logger.info('dispatchTurnToHarness: no live harness session, reconnecting via resume()', { sessionId })
      const sessionForReconnect = await this.ensureSessionWorktreePath(session)
      const permissionMode = this.permissionModes.get(sessionId) ?? sessionForReconnect.permissionMode
      const modelSelection = this.modelSelections.get(sessionId) ?? sessionForReconnect.modelSelection ?? undefined
      // fix-send-message-dropped-on-never-connected: for sessions that have
      // never connected, startFreshWithRetry is a lazy async generator —
      // this.sessions.set() (and therefore a valid queue to push to) only
      // happens inside startWithId, which runs when consume() first pulls from
      // the generator. Calling streamInput() before that would push to the OLD
      // closed queue (a silent no-op). Instead, pass the text as initialPrompt
      // so it's seeded into the new queue at startWithId/launch time.
      const needsInitialPrompt = !sessionForReconnect.everConnected
      const harnessSession = await this.reconnectHarness(sessionForReconnect, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort,
        ...(needsInitialPrompt ? { initialPrompt: text } : {})
      })
      if (!needsInitialPrompt) {
        await this.harness.streamInput(sessionId, text, attachments)
      }
      const previousTurnCount = this.live.get(sessionId)?.turnCount ?? 0
      const previousLive = this.live.get(sessionId)
      this.finalizeStaleRunningToolCalls(sessionId, previousLive)
      this.live.set(sessionId, newLiveStream(previousTurnCount))
      this.resetHarnessUiForSession(sessionId)
      const liveEntry = this.live.get(sessionId)!
      liveEntry.busy = true
      if (resolvedMessageId != null) {
        liveEntry.pendingUserMessageId = resolvedMessageId
        liveEntry.turnExecutionStarted = false
      }
      this.sendStatus(sessionId)
      void this.consume(sessionId, harnessSession.events, this.bumpConsumeGeneration(sessionId))
    } catch (err) {
      const q = this.turnQueues.get(sessionId)
      if (q) q.inflightId = null
      this.sendTurnState(sessionId, false)
      throw err
    }
  }

  /**
   * Enqueues a user message and immediately dispatches it if no turn is currently
   * inflight. The main process now owns the send queue; the renderer always calls
   * this regardless of busy state — no client-side queuing needed.
   */
  async sendUserMessage(sessionId: string, text: string, override?: ModelSelection, attachments?: FileAttachment[]): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (!attachments?.length && text.trim() === '/clear') {
      this.clearTurnQueue(sessionId)
      await this.clearConversation(sessionId)
      return
    }
    const content: string = attachments?.length
      ? JSON.stringify({ kind: 'files_attachment', files: attachments.map(({ mimeType, data, name }) => ({ mimeType, data, name })), text } satisfies FilesAttachmentContent)
      : text
    this.touchLastActive(sessionId)
    this.sendPromptSuggestion(sessionId, null)

    if (session.mode !== 'claude-code') {
      const userMessage = this.store.addMessage({ sessionId, role: 'user', content })
      this.sendMessage(sessionId, userMessage)
      return
    }

    const q = this.getOrCreateTurnQueue(sessionId)

    if (q.inflightId === null) {
      // Nothing inflight — add to DB, show in chat, dispatch immediately.
      const userMessage = this.store.addMessage({ sessionId, role: 'user', content })
      this.sendMessage(sessionId, userMessage)
      const item = this.makeQueuedEntry(text, attachments, override, userMessage.id)
      q.inflightId = item.id
      // No items to show in the queue strip (this message is already dispatching).
      this.sendQueueState(sessionId)
      logger.info('turnQueue: dispatching immediately (queue idle)', { sessionId, id: item.id })
      try {
        await this.dispatchTurnToHarness(sessionId, item)
      } catch (err) {
        this.reportHarnessFailure(sessionId, 'sendUserMessage', err)
        throw err
      }
    } else {
      // A turn is inflight — enqueue without adding to DB or chat yet.
      // dispatchTurnToHarness will add the message to the DB and show it
      // in the chat just before it's actually dispatched to the harness.
      const item = this.makeQueuedEntry(text, attachments, override)
      q.items.push(item)
      this.sendQueueState(sessionId)
      logger.info('turnQueue: enqueued (turn inflight)', { sessionId, id: item.id, queueDepth: q.items.length })
    }
  }

  /** True while the composer should show Stop — may lead `live.busy` during reconnect/streamInput setup. */
  private composerTurnActive(sessionId: string, live?: LiveStream | null): boolean {
    const entry = live ?? this.live.get(sessionId)
    return (
      (entry?.pendingUserMessageId != null) ||
      entry?.busy === true ||
      entry?.bufferMessageId != null ||
      (entry?.pendingTools.size ?? 0) > 0 ||
      entry?.thinkingMessageId != null ||
      this.connecting.has(sessionId)
    )
  }

  /** Immediate UI + transcript cleanup when Stop/ESC fires — don't wait for harness teardown. */
  private applyOptimisticInterrupt(sessionId: string, live: LiveStream): void {
    live.interruptRequested = true
    this.expirePendingPrompts(sessionId, live)
    this.flushBuffer(sessionId, live)
    this.finishThinkingBlock(sessionId, live, 'completed')
    this.finalizeStaleRunningToolCalls(sessionId, live)
    this.clearPendingUserTurn(live)
    live.busy = false
    this.clearTurnQueue(sessionId)
    this.sendTurnState(sessionId, false)
    if (this.connecting.has(sessionId)) {
      this.connecting.delete(sessionId)
    }
    this.sendStatus(sessionId)
  }

  /**
   * `/clear`: wipe the Atelier transcript immediately, then ask the live SDK
   * (or mint a fresh CLI conversation id if disconnected) so `--resume` cannot
   * restore the old turns.
   */
  async clearConversation(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.wipeConversation(sessionId)
    if (session.mode !== 'claude-code') return
    if (this.harness.isActive(sessionId)) {
      await this.harness.streamInput(sessionId, '/clear')
      return
    }
    const { randomUUID } = await import('node:crypto')
    this.store.setSdkSessionId(sessionId, randomUUID())
  }

  private wipeConversation(sessionId: string, newSdkSessionId?: string): void {
    this.store.clearMessages(sessionId)
    if (newSdkSessionId) this.store.setSdkSessionId(sessionId, newSdkSessionId)
    logger.info('conversation cleared', {
      sessionId,
      sdkSessionId: newSdkSessionId ?? this.store.getSdkSessionId(sessionId)
    })
    const live = this.live.get(sessionId)
    if (live) {
      this.expirePendingPrompts(sessionId, live)
      this.flushBuffer(sessionId, live)
      this.finishThinkingBlock(sessionId, live, 'completed')
      this.finalizeStaleRunningToolCalls(sessionId, live)
      this.clearPendingUserTurn(live)
      live.busy = false
      live.interruptRequested = false
      this.sendTurnState(sessionId, false)
      this.sendStatus(sessionId)
    }
    this.resetHarnessUiForSession(sessionId)
    this.sendBackgroundTasks(sessionId)
    this.sendSdkChrome(sessionId)
    this.sendTokenUsage(sessionId, 0, 0)
    this.sendPromptSuggestion(sessionId, null)
    this.sendMessagesCleared(sessionId)
  }

  async interrupt(sessionId: string): Promise<SessionInterruptResult> {
    const live = this.live.get(sessionId)
    const canWithdraw =
      live != null &&
      !live.turnExecutionStarted &&
      live.pendingUserMessageId != null

    if (canWithdraw) {
      const messageId = live!.pendingUserMessageId!
      const removed = this.store.deleteMessage(messageId)
      if (removed) this.sendMessageRemoved(sessionId, messageId)
      this.applyOptimisticInterrupt(sessionId, live!)
      await this.harness.interrupt(sessionId)
      return { action: 'withdrawn', restoredText: removed ? userMessagePlainText(removed.content) : '' }
    }

    if (live && this.composerTurnActive(sessionId, live)) {
      this.applyOptimisticInterrupt(sessionId, live)
    }
    await this.harness.interrupt(sessionId)
    return { action: 'interrupted' }
  }

  /** `/model <id>` validation against the live SDK — see `HarnessDriver.validateModel`. */
  async validateModel(sessionId: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.harness.validateModel(sessionId, model)
  }

  /** Settings default-model validation — see `HarnessDriver.validateClaudeModel`. */
  async validateClaudeModel(model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.harness.validateClaudeModel(model)
  }

  // ── Interactive prompts (05-interactive-prompts) ─────────────────────

  /**
   * Resolves a pending permission/AskUserQuestion/plan card: updates the
   * persisted message row to its resolved state (same "mutate in place"
   * pattern as `tool_call_end`) and unblocks the harness's `canUseTool`
   * call. Throws if `requestId` doesn't match a currently-pending prompt for
   * this session (e.g. a stale double-click after the harness already
   * resolved/moved on) so the renderer's IPC call surfaces the mismatch
   * instead of silently doing nothing.
   */
  async respondToPrompt(sessionId: string, requestId: string, decision: PromptDecision): Promise<void> {
    const live = this.live.get(sessionId)
    const pending = live?.pendingPrompts.get(requestId)
    if (!live || !pending) throw new Error(`Unknown or already-resolved prompt: ${requestId}`)

    const resolvedContent = applyDecision(pending.content, decision)
    const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(resolvedContent) })
    if (updated) this.sendMessage(sessionId, updated)
    live.pendingPrompts.delete(requestId)

    // Mirrors the real SDK-side transition this same decision triggers
    // inside `canUseTool` (see claude-agent-sdk-harness.ts's `setPermissionMode`
    // call): once a plan is genuinely accepted, the session is out of plan
    // mode for good, so stop re-asserting `permissionMode: 'plan'` on future
    // `resume()` reconnects for it. A reject/keep-planning decision leaves
    // the tracked mode untouched — the session is still (and must remain)
    // in plan mode for the next reconnect.
    if (decision.kind === 'plan' && decision.decision === 'accept') {
      this.permissionModes.set(sessionId, 'default')
      this.store.setPermissionMode(sessionId, 'default')
      // 11-composer-mode-indicator: the mode pill must reflect this
      // automatic flip the same way it reflects a manual Shift+Tab cycle —
      // without this broadcast the pill would keep showing "Plan mode" until
      // some UNRELATED lifecycle event happened to trigger a refetch.
      const session = this.store.getSession(sessionId)
      if (session) this.sendLifecycle({ type: 'session.updated', session: this.decorate(session) })
    }

    // The turn that raised this prompt has been sitting blocked inside
    // `canUseTool` this whole time — `live.busy` was never flipped false for
    // it (see `applyEvent`'s `permission_request`/`ask_user_question`/
    // `plan_proposed` cases, which don't touch `busy`), so in the normal
    // "prompt raised mid-turn-that-set-busy-true" case this is a no-op.
    // But a turn resumed via `sendUserMessage`'s streamInput fast path (an
    // already-live harness connection, i.e. reusing turnCount for a
    // follow-up message once the session is 'waiting' between turns) never
    // sets `live.busy = true` in the first place, so once a prompt from THAT
    // turn is answered here, the dot would otherwise stay stuck on 'waiting'
    // (rendered purple 'waiting-input') even though the harness is actively
    // running tool calls again. Explicitly (re)assert busy=true and push
    // both status channels here so the dot/turn-state always reflect reality
    // the instant the user's decision is dispatched, regardless of which
    // path started the turn.
    live.busy = true
    this.sendStatus(sessionId)
    this.sendTurnState(sessionId, true)

    logger.info('respondToPrompt: dispatching to harness', { sessionId, requestId, kind: decision.kind })

    if (pending.content.kind === 'plan_proposed') {
      const planContent = pending.content
      const session = this.getSession(sessionId)
      if (session) {
        const workspaceRoot = session.worktreePath ?? session.projectPath
        void registerPlanFileInSessionChangesCap(
          this.store,
          sessionId,
          workspaceRoot,
          workspaceRoot,
          session.hostname
        ).then((cap) => {
          this.publishSessionChangesCap(sessionId, cap)
        })
      }
    }

    await this.harness.respondToPrompt(sessionId, requestId, toHarnessPromptResponse(decision))
  }

  // ── Mode cycling (11-composer-mode-indicator) ─────────────────────────

  /**
   * Persists a model/effort selection for a session without sending a message
   * (fix-model-persist-on-slash-model): called immediately when the renderer's
   * `/model <id>` slash command fires so the selection survives a relaunch
   * even if no subsequent message is sent. Mirrors the same Map+store write
   * that `sendUserMessage` does when it detects a changed selection.
   */
  persistModelSelection(sessionId: string, selection: ModelSelection): void {
    // Persist for resume/display only — the in-memory `modelSelections` Map
    // tracks what's actually running on the live harness and is updated in
    // `sendUserMessage` when a new selection is applied. Updating the Map
    // here too made picker changes look "already applied" on the very next
    // send, skipping the forced reconnect that model/effort overrides require.
    this.store.setModelSelection(sessionId, selection)
  }

  /**
   * Cycles a session's SDK permission mode through `MODE_CYCLE`
   * (default -> plan -> acceptEdits -> auto -> default), triggered by the
   * composer's Shift+Tab handler or a click on the mode pill. Updates the
   * tracked mode immediately (so it's re-passed on the session's next
   * `resume()`/follow-up, exactly like the pre-existing plan-mode tracking)
   * and, if the session has a live harness connection right now, also flips
   * it on that connection immediately via `harness.setPermissionMode()` —
   * the same real `query.setPermissionMode()` call already used after an
   * accepted `ExitPlanMode` — so the change takes effect for the CURRENT
   * turn/session, not just the next reconnect.
   */
  async cycleMode(sessionId: string): Promise<SessionRecord> {
    const existing = this.store.getSession(sessionId)
    if (!existing) throw new Error(`Unknown session: ${sessionId}`)

    const current = this.permissionModes.get(sessionId) ?? existing.permissionMode
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length]
    this.permissionModes.set(sessionId, next)
    this.store.setPermissionMode(sessionId, next)
    logger.info('cycleMode: mode changed', { sessionId, from: current, to: next })

    if (existing.mode === 'claude-code') {
      await this.harness.setPermissionMode(sessionId, next)
    }

    const session = this.decorate(existing)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  /**
   * A thrown error from a harness call (resume/streamInput/start) used to
   * disappear silently: the IPC promise would reject, but nothing logged it
   * in the main process and the renderer's `handleSend`/`resumeSession`
   * callers don't currently catch or surface a rejected
   * `session:sendMessage`/`session:resume` call (confirmed by inspection —
   * see App.tsx's `handleSend` and useSessions.ts's `resumeSession`, neither
   * of which wraps its `await` in try/catch). So in addition to logging,
   * this turns the failure into the same kind of visible system-role
   * transcript message that `applyEvent`'s `case 'error':` produces for an
   * in-stream harness error event — the user always sees SOMETHING in the
   * chat, regardless of whether the renderer ever handles the rejection.
   */
  private reportHarnessFailure(sessionId: string, context: string, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error('harness call failed', { sessionId, context, error: errorMessage })
    const message = this.store.addMessage({
      sessionId,
      role: 'system',
      content: `Error: ${formatHarnessErrorForUser(errorMessage)}`
    })
    this.sendMessage(sessionId, message)
    // The harness call itself threw (never reached applyEvent's terminal
    // cases), so 'busy' would otherwise stay stuck true forever.
    const live = this.live.get(sessionId)
    if (live) live.busy = false
    this.sendStatus(sessionId)
  }

  // ── Fork / Restart ──────────────────────────────────────────────────

  forkSession(sourceId: string): SessionRecord {
    const source = this.store.getSession(sourceId)
    const forked = this.store.forkSession(sourceId)
    if (!forked) throw new Error(`Unknown session: ${sourceId}`)
    if (source) {
      this.permissionModes.set(forked.id, source.permissionMode)
      if (source.modelSelection) {
        this.modelSelections.set(forked.id, source.modelSelection)
      }
    }
    this.sendLifecycle({ type: 'session.forked', session: forked, sourceId })
    return this.decorate(forked)
  }

  async restartSession(sourceId: string): Promise<SessionRecord> {
    const source = this.getSession(sourceId)
    if (!source) throw new Error(`Unknown session: ${sourceId}`)

    // Make the copied transcript internally consistent before replacing the
    // source row. In particular, do not carry an indefinitely-running tool
    // card into a brand-new harness conversation.
    this.markInterruptedTurnNoticeIfBusy(sourceId)
    this.finalizeStaleRunningToolCalls(sourceId, this.live.get(sourceId))
    this.deliverPendingTurnInterruptedNotice(sourceId)

    const restarted = this.store.restartSession(sourceId)
    if (!restarted) throw new Error(`Unknown session: ${sourceId}`)

    // Restart replaces rather than archives the old session. Tear down all
    // source-id runtime state without deleting its worktree: the replacement
    // deliberately inherited that same checkout.
    void this.harness.interrupt(sourceId).catch(() => undefined)
    this.live.delete(sourceId)
    this.invalidateConsume(sourceId)
    this.connecting.delete(sourceId)
    this.creatingWorktree.delete(sourceId)
    this.pendingPanelPreload.delete(sourceId)
    this.workspacePreloadInFlight.delete(sourceId)
    this.clearCapRefreshDebounce(sourceId)
    this.workspace?.evictSession(sourceId)
    this.portForwards?.removeAllForSession(sourceId)
    this.sendTurnState(sourceId, false)
    this.resetHarnessUiForSession(sourceId)

    this.permissionModes.delete(sourceId)
    this.modelSelections.delete(sourceId)
    this.permissionModes.set(restarted.id, source.permissionMode)
    if (source.modelSelection) {
      this.modelSelections.set(restarted.id, source.modelSelection)
    }

    this.sendLifecycle({ type: 'session.deleted', sessionId: sourceId })
    this.sendLifecycle({ type: 'session.forked', session: this.decorate(restarted), sourceId })

    // A copied transcript made selectSession() believe the new session was
    // already hydrated, so the renderer skipped its normal reconnect path.
    // Start the fresh-id harness here, before returning the replacement.
    try {
      await this.reconnect(restarted.id)
    } catch {
      // reconnect() already logs and persists a visible system error. Still
      // return/select the replacement so the user can see and retry it.
    }
    return this.decorate(restarted)
  }

  // ── Close / Delete / Rename / Pin ────────────────────────────────────

  async closeSession(sessionId: string): Promise<SessionRecord> {
    logger.info('closeSession invoked', { sessionId })
    this.markInterruptedTurnNoticeIfBusy(sessionId)
    const beforeClose = this.store.getSession(sessionId)
    if (!beforeClose) throw new Error(`Unknown session: ${sessionId}`)
    // Never block Close on harness teardown — same fire-and-forget pattern as
    // the pre-async closeSession; interrupt can hang on mid-stream turns.
    void this.harness.interrupt(sessionId).catch(() => undefined)
    const live = this.live.get(sessionId)
    this.finalizeStaleRunningToolCalls(sessionId, live)
    this.live.delete(sessionId)
    this.invalidateConsume(sessionId)
    // A session can be closed again while a previous reconnect() is still in
    // flight (e.g. rapid resume/close) — don't leave a stale 'connecting'
    // pill visible for a session that's no longer even open.
    this.connecting.delete(sessionId)
    this.creatingWorktree.delete(sessionId)
    this.pendingPanelPreload.delete(sessionId)
    this.workspacePreloadInFlight.delete(sessionId)
    this.clearCapRefreshDebounce(sessionId)
    this.workspace?.evictSession(sessionId)
    this.clearTurnQueue(sessionId)
    this.turnQueues.delete(sessionId)
    this.sendTurnState(sessionId, false)
    this.resetHarnessUiForSession(sessionId)
    const session = this.store.closeSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendStatus(sessionId)
    this.sendLifecycle({ type: 'session.closed', session })
    return session
  }

  async linkDailyTask(
    sessionId: string,
    noteDate: string,
    taskGid: string
  ): Promise<SessionRecord> {
    await linkDailyTaskToSession(this.store, this.getWindow, sessionId, noteDate, taskGid)
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const decorated = this.decorate(session)
    this.sendLifecycle({ type: 'session.updated', session: decorated })
    return decorated
  }

  async completeLinkedDailyTask(sessionId: string): Promise<void> {
    await completeLinkedDailyTask(this.store, this.getWindow, sessionId)
  }

  deleteSession(sessionId: string): Promise<void> {
    const existing = this.sessionCleanupInFlight.get(sessionId)
    if (existing) return existing

    const cleanup = this.runSessionCleanup(sessionId).finally(() => {
      if (this.sessionCleanupInFlight.get(sessionId) === cleanup) {
        this.sessionCleanupInFlight.delete(sessionId)
      }
    })
    this.sessionCleanupInFlight.set(sessionId, cleanup)
    return cleanup
  }

  /** Resume durable cleanup markers left by a quit, crash, or unreachable remote host. */
  resumePendingSessionCleanup(): void {
    for (const session of this.store.listSessionsPendingDeletion()) {
      void this.deleteSession(session.id).catch((err) => {
        logger.error('session cleanup retry failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
  }

  private async runSessionCleanup(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return

    const cleanupStartedAt = Date.now()
    const wasCreatingWorktree = this.creatingWorktree.has(sessionId)
    const deleting = this.store.markSessionDeleting(sessionId)
    if (!deleting) return
    logger.info('session cleanup started', {
      sessionId,
      worktreePath: deleting.worktreePath,
      hostname: deleting.hostname
    })
    this.sendLifecycle({ type: 'session.updated', session: this.decorate(deleting) })
    this.sendStatus(sessionId)

    this.markInterruptedTurnNoticeIfBusy(sessionId)
    const live = this.live.get(sessionId)
    this.finalizeStaleRunningToolCalls(sessionId, live)
    await this.harness.interrupt(sessionId).catch((err) => {
      logger.warn('session cleanup: harness interrupt failed (continuing)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    this.live.delete(sessionId)
    this.invalidateConsume(sessionId)
    this.connecting.delete(sessionId)
    this.creatingWorktree.delete(sessionId)
    this.startupIdle.delete(sessionId)
    this.worktreeMissingChecked.delete(sessionId)
    this.pendingPanelPreload.delete(sessionId)
    this.workspacePreloadInFlight.delete(sessionId)
    this.clearCapRefreshDebounce(sessionId)
    this.workspace?.evictSession(sessionId)
    this.portForwards?.removeAllForSession(sessionId)
    this.sendTurnState(sessionId, false)
    this.resetHarnessUiForSession(sessionId)

    await removeClaudeSessionFiles(deleting)

    const hostname = deleting.hostname
      ? this.hosts.resolveByHostname(deleting.hostname)?.sshHost
      : undefined
    const sharedWorktree =
      !!deleting.worktreePath &&
      this.store.hasOtherSessionUsingWorktree(sessionId, deleting.worktreePath)
    if (sharedWorktree) {
      logger.info('session cleanup: preserving shared worktree', {
        sessionId,
        worktreePath: deleting.worktreePath
      })
    } else if (deleting.worktreePath || wasCreatingWorktree) {
      await this.cleanupSessionWorktree(deleting, { clearStoredPath: false })
      const homeDir = this.homeDirForStoredSession(deleting)
      const expectedPath =
        deleting.worktreePath ??
        sessionWorktreePath(worktreeRootFromConfig(loadConfig()), sessionId, homeDir)
      if (await worktreePathExists(expectedPath, hostname)) {
        throw new Error(`Worktree cleanup did not remove ${expectedPath}`)
      }
    }

    const remainingVisibleMs = MIN_SESSION_CLEANUP_VISIBLE_MS - (Date.now() - cleanupStartedAt)
    if (remainingVisibleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingVisibleMs))
    }

    this.permissionModes.delete(sessionId)
    this.modelSelections.delete(sessionId)
    this.store.deleteSession(sessionId)
    logger.info('session cleanup completed', { sessionId })
    this.sendLifecycle({ type: 'session.deleted', sessionId })
  }

  renameSession(sessionId: string, name: string): SessionRecord {
    const session = this.store.renameSession(sessionId, name)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.renamed', session })
    return session
  }

  setPinned(sessionId: string, pinned: boolean): SessionRecord {
    const session = this.store.setPinned(sessionId, pinned)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  setColor(sessionId: string, color: string): SessionRecord {
    const session = this.store.setColor(sessionId, color)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  /**
   * Persists the session's last workspace tab (remember-session-tab).
   * Deliberately silent — no `session.updated` lifecycle event — because every
   * tab click would otherwise refetch and re-render the whole session list.
   */
  setActiveTab(sessionId: string, tab: SessionTab): void {
    this.store.setActiveTab(sessionId, tab)
  }

  setNotes(sessionId: string, notes: string): SessionRecord {
    const session = this.store.setNotes(sessionId, notes)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  /** Updates persisted project path and reloads workspace panels (diff/files/terminal cwd). */
  async setProjectPath(sessionId: string, projectPath: string): Promise<SessionRecord> {
    const trimmed = projectPath.trim()
    if (!trimmed) throw new Error('Project path is required')

    let session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    if (session.projectPath === trimmed && !session.worktreePath) {
      return this.decorate(session)
    }

    const oldPath = session.projectPath
    const hostname = session.hostname

    if (session.worktreePath) {
      this.store.setWorktreePath(sessionId, null)
      session = { ...session, worktreePath: null }
    }

    session = this.store.setProjectPath(sessionId, trimmed)!
    const hostId = session.hostname
      ? (this.hosts.resolveByHostname(session.hostname)?.id ?? session.hostname)
      : 'local'
    this.store.recordProjectPathUsage(hostId, trimmed)

    invalidateGitRepository(oldPath, hostname)
    invalidateGitRepository(trimmed, hostname)

    this.workspace?.stopMonitor(sessionId)
    this.workspace?.evictSession(sessionId)

    const newCwd = this.resolveHarnessCwd(session.projectPath, session.hostname, session.worktreePath)
    const live = this.live.get(sessionId)
    if (live) {
      live.harnessCwd = newCwd
      this.sendHarnessCwd(sessionId, newCwd)
    }

    if (session.mode === 'claude-code' && this.workspace) {
      await this.workspace.completeSessionOpen(session)
    }

    const decorated = this.decorate(session)
    this.sendLifecycle({ type: 'session.updated', session: decorated })
    return decorated
  }

  addTag(sessionId: string, tag: string): SessionRecord {
    const session = this.store.addTag(sessionId, tag)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  removeTag(sessionId: string, tag: string): SessionRecord {
    const session = this.store.removeTag(sessionId, tag)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  listAllTags(): string[] {
    return this.store.listAllTags()
  }

  // ── Groups (06-session-organization) ─────────────────────────────────

  listGroups(): SessionGroupRecord[] {
    return this.store.listGroups()
  }

  private sendGroupEvent(event: SessionGroupEvent): void {
    this.getWindow()?.webContents.send('group:changed', event)
  }

  createGroup(name: string): SessionGroupRecord {
    const group = this.store.createGroup(name)
    this.sendGroupEvent({ type: 'group.created', group })
    return group
  }

  renameGroup(groupId: string, name: string): SessionGroupRecord {
    const group = this.store.renameGroup(groupId, name)
    if (!group) throw new Error(`Unknown group: ${groupId}`)
    this.sendGroupEvent({ type: 'group.renamed', group })
    return group
  }

  setGroupCollapsed(groupId: string, collapsed: boolean): SessionGroupRecord {
    const group = this.store.setGroupCollapsed(groupId, collapsed)
    if (!group) throw new Error(`Unknown group: ${groupId}`)
    this.sendGroupEvent({ type: 'group.updated', group })
    return group
  }

  deleteGroup(groupId: string): void {
    const members = this.store.listActiveSessions().filter((s) => s.groupId === groupId)
    this.store.deleteGroup(groupId)
    this.sendGroupEvent({ type: 'group.deleted', groupId })
    for (const session of members) {
      this.sendLifecycle({ type: 'session.updated', session: { ...session, groupId: null } })
    }
  }

  reorderGroups(orderedIds: string[]): SessionGroupRecord[] {
    const groups = this.store.reorderGroups(orderedIds)
    this.sendGroupEvent({ type: 'group.reordered', groups })
    return groups
  }

  setSessionGroup(sessionId: string, groupId: string | null): SessionRecord {
    const session = this.store.setSessionGroup(sessionId, groupId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
  }

  /** Persists a manual drag-drop re-order (and possible re-parent) for a section: pinned (groupId undefined), a specific group id, or ungrouped (groupId null). */
  reorderSessions(groupId: string | null | undefined, orderedIds: string[]): SessionRecord[] {
    const sessions = this.store.reorderSessions(groupId, orderedIds)
    for (const session of sessions) this.sendLifecycle({ type: 'session.updated', session })
    return sessions
  }

  // ── Event stream consumption ─────────────────────────────────────────

  private async consume(
    sessionId: string,
    events: AsyncGenerator<HarnessEvent, void, void>,
    generation: number
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (this.consumeGeneration.get(sessionId) !== generation) return
        if (!this.store.getSession(sessionId)) return
        this.applyEvent(sessionId, event)
      }
    } catch (err) {
      // A closed/restarted generation commonly throws while its subprocess
      // is being interrupted; it no longer owns this session and must not
      // publish a late failure into the replacement/current UI.
      if (this.consumeGeneration.get(sessionId) !== generation) return
      const session = this.store.getSession(sessionId)
      if (!session || session.closedAt) return

      // Async generators are lazy: startFreshWithRetry() can throw from
      // harness.startWithId() only after reconnect() has already returned.
      // Logging alone left `connecting` set forever and produced a dead
      // session with no visible explanation.
      this.connecting.delete(sessionId)
      this.pendingPanelPreload.delete(sessionId)
      this.workspacePreloadInFlight.delete(sessionId)
      this.reportHarnessFailure(sessionId, 'event stream', err)
      // fix-consume-throw-stuck-queue: mirrors fix-error-stuck-queue in
      // case 'error':. When the async generator throws (subprocess crash,
      // SDK failure before any event is emitted), applyEvent's terminal
      // cases never run, so inflightId stays set forever and all queued
      // messages silently get stuck behind it.
      const q = this.turnQueues.get(sessionId)
      if (q) q.inflightId = null
      const drained = this.drainTurnQueue(sessionId)
      if (!drained) this.sendTurnState(sessionId, false)
    }
  }

  private markInterruptedTurnNoticeIfBusy(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const turnInFlight = live.busy || live.bufferMessageId != null || live.pendingTools.size > 0
    if (turnInFlight) {
      this.store.setPendingTurnInterruptedNotice(sessionId)
    }
  }

  /** Inserts {@link TURN_INTERRUPTED_NOTICE} at most once per pending flag. */
  private deliverPendingTurnInterruptedNotice(sessionId: string): void {
    if (!this.store.consumePendingTurnInterruptedNotice(sessionId)) return
    const message = this.store.addMessage({
      sessionId,
      role: 'system',
      content: TURN_INTERRUPTED_NOTICE
    })
    this.sendMessage(sessionId, message)
  }

  private applyEvent(sessionId: string, event: HarnessEvent): void {
    if (!this.store.getSession(sessionId)) return
    const live = this.live.get(sessionId) ?? newLiveStream()
    this.live.set(sessionId, live)
    if (
      live.interruptRequested &&
      event.type !== 'interrupted' &&
      event.type !== 'error' &&
      event.type !== 'result' &&
      event.type !== 'conversation_reset'
    ) {
      return
    }
    const needsWorkspacePreload = this.pendingPanelPreload.delete(sessionId)
    if (needsWorkspacePreload) {
      this.startupAutoReconnect.delete(sessionId)
      const row = this.store.getSession(sessionId)
      if (this.workspace && row?.mode === 'claude-code') {
        if (!this.connecting.has(sessionId)) {
          this.connecting.add(sessionId)
        }
        this.workspacePreloadInFlight.add(sessionId)
        this.sendStatus(sessionId)
        void this.workspace.completeSessionOpen(this.decorate(row)).finally(() => {
          this.workspacePreloadInFlight.delete(sessionId)
          this.connecting.delete(sessionId)
          this.sendStatus(sessionId)
        })
      } else {
        if (this.connecting.has(sessionId)) {
          this.connecting.delete(sessionId)
          this.sendStatus(sessionId)
        }
      }
    }

    switch (event.type) {
      case 'thinking_block_start': {
        this.markTurnExecutionStarted(live)
        this.finishThinkingBlock(sessionId, live, 'completed')
        const content: ThinkingBlockContent = {
          kind: 'thinking_block',
          status: 'running',
          text: '',
          parentToolUseId: event.parentToolUseId,
        }
        const message = this.store.addMessage({
          sessionId,
          role: 'assistant',
          content: JSON.stringify(content),
          rawEvent: event,
        })
        live.thinkingMessageId = message.id
        live.thinkingText = ''
        live.thinkingParentToolUseId = event.parentToolUseId
        this.harnessUi.setThinkingChrome(sessionId)
        this.sendSdkChrome(sessionId)
        this.sendMessage(sessionId, message)
        return
      }

      case 'thinking_delta': {
        if (live.thinkingMessageId == null) return
        live.thinkingText += event.text
        const content: ThinkingBlockContent = {
          kind: 'thinking_block',
          status: 'running',
          text: live.thinkingText,
          parentToolUseId: event.parentToolUseId,
          ...(live.thinkingEstimatedTokens != null ? { estimatedTokens: live.thinkingEstimatedTokens } : {}),
        }
        const updated = this.store.updateMessage(live.thinkingMessageId, {
          content: JSON.stringify(content),
          rawEvent: event,
        })
        if (updated) this.sendMessage(sessionId, updated)
        return
      }

      case 'thinking_block_end': {
        this.finishThinkingBlock(sessionId, live, 'completed')
        return
      }

      case 'thinking_tokens': {
        if (live.thinkingMessageId == null) return
        const content: ThinkingBlockContent = {
          kind: 'thinking_block',
          status: 'running',
          text: live.thinkingText,
          estimatedTokens: event.estimatedTokens,
          parentToolUseId: live.thinkingParentToolUseId,
        }
        live.thinkingEstimatedTokens = event.estimatedTokens
        this.harnessUi.setThinkingChrome(sessionId, event.estimatedTokens)
        this.sendSdkChrome(sessionId)
        const updated = this.store.updateMessage(live.thinkingMessageId, {
          content: JSON.stringify(content),
          rawEvent: event,
        })
        if (updated) this.sendMessage(sessionId, updated)
        return
      }

      case 'tool_input_delta': {
        const pending = live.pendingTools.get(event.toolUseId)
        if (!pending) return
        const content: ToolCallContent = {
          ...pending.content,
          inputStreamJson: event.partialJson,
        }
        pending.content = content
        const updated = this.store.updateMessage(pending.messageId, {
          content: JSON.stringify(content),
          rawEvent: event,
        })
        if (updated) this.sendMessage(sessionId, updated)
        return
      }

      case 'text_delta': {
        this.markTurnExecutionStarted(live)
        this.finishThinkingBlock(sessionId, live, 'completed')
        // First delta of a segment: persist an (initially empty) placeholder
        // row immediately so the renderer has a stable message id to attach
        // progressive `session:streamDelta` pushes to — token-level
        // rendering happens entirely over that channel; only the FINAL text
        // is written back to this same row (via flushBuffer), so the "one
        // row per message" DB model still holds (one insert + one update,
        // never one row per token).
        if (live.bufferMessageId == null) {
          const placeholder = this.store.addMessage({ sessionId, role: 'assistant', content: '' })
          live.bufferMessageId = placeholder.id
          this.sendMessage(sessionId, placeholder)
        }
        live.buffer += event.text
        this.sendStreamDelta(sessionId, live.bufferMessageId, live.buffer)
        return
      }

      case 'tool_call_start': {
        this.markTurnExecutionStarted(live)
        this.flushBuffer(sessionId, live)
        this.finishThinkingBlock(sessionId, live, 'completed')
        const existing = live.pendingTools.get(event.toolUseId)
        if (existing) {
          const content: ToolCallContent = {
            ...existing.content,
            name: event.name,
            input: event.input,
            inputStreamJson: undefined,
            parentToolUseId: event.parentToolUseId,
          }
          existing.content = content
          const updated = this.store.updateMessage(existing.messageId, {
            content: JSON.stringify(content),
            rawEvent: event,
          })
          if (updated) this.sendMessage(sessionId, updated)
          if (event.name === 'Bash') {
            const command = (event.input as { command?: string } | undefined)?.command
            const row = this.store.getSession(sessionId)
            const base =
              live.harnessCwd ?? (row ? (row.worktreePath ?? row.projectPath) : null)
            if (command && base) {
              const next = applyBashCdCommands(base, command)
              if (next !== base) {
                live.harnessCwd = next
                this.sendHarnessCwd(sessionId, next)
              }
            }
          }
          return
        }
        if (event.name === 'Bash') {
          const command = (event.input as { command?: string } | undefined)?.command
          const row = this.store.getSession(sessionId)
          const base =
            live.harnessCwd ?? (row ? (row.worktreePath ?? row.projectPath) : null)
          if (command && base) {
            const next = applyBashCdCommands(base, command)
            if (next !== base) {
              live.harnessCwd = next
              this.sendHarnessCwd(sessionId, next)
            }
          }
        }
        const content: ToolCallContent = {
          kind: 'tool_call',
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          status: 'running',
          parentToolUseId: event.parentToolUseId
        }
        const message = this.store.addMessage({
          sessionId,
          role: 'assistant',
          content: JSON.stringify(content),
          rawEvent: event
        })
        live.pendingTools.set(event.toolUseId, { messageId: message.id, content })
        this.sendMessage(sessionId, message)
        return
      }

      case 'tool_call_end': {
        const pending = live.pendingTools.get(event.toolUseId)
        if (!pending) return // e.g. a tool call from a prior (already-flushed) turn after resume
        const content: ToolCallContent = {
          ...pending.content,
          status: event.isError ? 'error' : 'completed',
          output: event.output
        }
        const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(content), rawEvent: event })
        if (updated) this.sendMessage(sessionId, updated)
        live.pendingTools.delete(event.toolUseId)
        if (!event.isError) {
          const session = this.getSession(sessionId)
          if (session) {
            const toolName = pending.content.name
            const input = pending.content.input
            const workspaceRoot = session.worktreePath ?? session.projectPath
            const workspacePath = workspaceRoot
            if (isSessionFileEditTool(toolName)) {
              void registerFileEditToolTouchedPaths(
                this.store,
                sessionId,
                workspaceRoot,
                workspacePath,
                session.hostname,
                toolName,
                input,
                session.projectPath
              ).then(() => {
                this.scheduleCapRefreshAfterMutation(sessionId)
              })
            } else if (toolName === 'Bash') {
              const command = (input as { command?: string } | undefined)?.command
              if (command && bashCommandMayAffectSessionChanges(command)) {
                this.scheduleCapRefreshAfterMutation(sessionId)
              }
            }
          }
        }
        return
      }

      case 'tool_progress': {
        const pending = live.pendingTools.get(event.toolUseId)
        if (!pending) return
        const content: ToolCallContent = {
          ...pending.content,
          elapsedTimeSeconds: event.elapsedTimeSeconds,
        }
        pending.content = content
        const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(content), rawEvent: event })
        if (updated) this.sendMessage(sessionId, updated)
        return
      }

      case 'todo_update': {
        // Not its own transcript row visually (rendered in the tracker rail
        // instead) but still persisted as an ordinary message so resume
        // reconstructs the last-known todo state without a schema change.
        const content: TodoUpdateContent = { kind: 'todo_update', todos: event.todos }
        const message = this.store.addMessage({ sessionId, role: 'system', content: JSON.stringify(content), rawEvent: event })
        this.sendMessage(sessionId, message)
        return
      }

      case 'compaction': {
        this.flushBuffer(sessionId, live)
        const content: CompactionContent = { kind: 'compaction', trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens }
        const message = this.store.addMessage({ sessionId, role: 'system', content: JSON.stringify(content), rawEvent: event })
        this.sendMessage(sessionId, message)
        return
      }

      case 'session_started':
        live.harnessCwd = event.cwd
        this.sendHarnessCwd(sessionId, event.cwd)
        // Not rendered as its own transcript row, but logged (10f-enrichment-
        // model-effort-picker) so e2e specs — and anyone debugging a "did my
        // model/effort change actually take" question — can grep the REAL
        // model the SDK resolved for this connection, straight from its own
        // `system`/`init` message (`event.model`), independent of whatever
        // string was requested via `HarnessStartOptions.model`.
        logger.info('harness event: session_started', {
          sessionId,
          model: event.model,
          apiKeySource: event.apiKeySource,
          cwd: event.cwd
        })
        // fix-no-conversation-found-remote-resume: this IS the CLI's own
        // confirmation that a real conversation now exists server-side for
        // this session id — persisted so every future reconnect (this run or
        // after a relaunch) can tell whether `harness.resume()` is even valid
        // to call for it. See SessionStore.markEverConnected's doc comment.
        this.store.markEverConnected(sessionId)
        return

      case 'commands_updated':
        // bug #56: not a transcript row — a live sidecar list for the
        // composer's slash-command autocomplete. Logged so e2e specs can
        // grep proof the list actually came from the SDK (not a re-hardcoded
        // client array).
        logger.info('harness event: commands_updated', { sessionId, commandNames: event.commands.map((c) => c.name) })
        this.sendCommands(sessionId, event.commands)
        return

      case 'models_updated':
        logger.info('harness event: models_updated', {
          sessionId,
          modelIds: event.models.map((m) => m.value)
        })
        this.sendModels(sessionId, event.models)
        return

      case 'prompt_suggestion':
        logger.info('harness event: prompt_suggestion', { sessionId, length: event.suggestion.length })
        this.sendPromptSuggestion(sessionId, event.suggestion)
        return

      case 'permission_request': {
        this.markTurnExecutionStarted(live)
        this.flushBuffer(sessionId, live)
        const content: PermissionRequestContent = {
          kind: 'permission_request',
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          title: event.title,
          description: event.description,
          suggestedPattern: event.suggestedPattern,
          status: 'pending'
        }
        const message = this.store.addMessage({ sessionId, role: 'assistant', content: JSON.stringify(content), rawEvent: event })
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content })
        this.sendMessage(sessionId, message)
        return
      }

      case 'ask_user_question': {
        this.markTurnExecutionStarted(live)
        this.flushBuffer(sessionId, live)
        const content: AskUserQuestionContent = {
          kind: 'ask_user_question',
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          questions: event.questions,
          status: 'pending'
        }
        const message = this.store.addMessage({ sessionId, role: 'assistant', content: JSON.stringify(content), rawEvent: event })
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content })
        this.sendMessage(sessionId, message)
        return
      }

      case 'plan_proposed': {
        this.markTurnExecutionStarted(live)
        this.flushBuffer(sessionId, live)
        const content: PlanProposedContent = {
          kind: 'plan_proposed',
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          plan: event.plan,
          planFilePath: event.planFilePath,
          status: 'pending'
        }
        const message = this.store.addMessage({ sessionId, role: 'assistant', content: JSON.stringify(content), rawEvent: event })
        live.pendingPrompts.set(event.requestId, { messageId: message.id, content })
        this.sendMessage(sessionId, message)
        {
          const session = this.getSession(sessionId)
          if (session) {
            const workspaceRoot = session.worktreePath ?? session.projectPath
            void registerPlanFileInSessionChangesCap(
              this.store,
              sessionId,
              workspaceRoot,
              workspaceRoot,
              session.hostname
            ).then((cap) => {
              this.publishSessionChangesCap(sessionId, cap)
            })
          }
        }
        return
      }

      case 'error': {
        this.flushBuffer(sessionId, live)
        const message = this.store.addMessage({
          sessionId,
          role: 'system',
          content: `Error: ${formatHarnessErrorForUser(event.message)}`,
          rawEvent: event
        })
        this.sendMessage(sessionId, message)
        live.busy = false
        this.clearPendingUserTurn(live)
        this.sendStatus(sessionId)
        // fix-error-stuck-queue: Clear inflightId and drain the turn queue,
        // mirroring what case 'result': does. Without this, an error event
        // (e.g. from startFreshWithRetry exhausting all retries with "Session
        // ID already in use") leaves inflightId set forever — any subsequent
        // sendUserMessage() sees inflightId != null and enqueues rather than
        // dispatching, so the session is permanently stuck and the user can
        // never submit another prompt. drainTurnQueue dispatches the next
        // queued message (if any) so queued messages survive a failed turn.
        const errQ = this.turnQueues.get(sessionId)
        if (errQ) errQ.inflightId = null
        const errDrained = this.drainTurnQueue(sessionId)
        if (!errDrained) this.sendTurnState(sessionId, false)
        return
      }

      case 'interrupted':
        this.flushBuffer(sessionId, live)
        this.finalizeStaleRunningToolCalls(sessionId, live)
        this.expirePendingPrompts(sessionId, live)
        live.busy = false
        live.interruptRequested = false
        this.clearPendingUserTurn(live)
        this.clearTurnQueue(sessionId)
        this.sendStatus(sessionId)
        logger.info('harness event: interrupted (terminal)', { sessionId })
        this.sendTurnState(sessionId, false)
        return

      case 'result': {
        this.flushBuffer(sessionId, live)
        live.turnCount += 1
        live.busy = false
        this.clearPendingUserTurn(live)
        this.sendPromptSuggestion(sessionId, null)
        this.sendStatus(sessionId)
        logger.info('harness event: result (turn complete)', {
          sessionId,
          turnCount: live.turnCount,
          isError: event.isError,
          subtype: event.subtype,
          errors: event.errors
        })
        if (event.isError) {
          const content: TranscriptNoticeContent = {
            kind: 'transcript_notice',
            level: 'danger',
            label: 'Error',
            text: this.formatTurnErrorMessage(event)
          }
          const errorMessage = this.store.addMessage({
            sessionId,
            role: 'system',
            content: JSON.stringify(content),
            rawEvent: event
          })
          this.sendMessage(sessionId, errorMessage)
        }
        // `event.totalCostUsd` is cumulative for the whole live connection
        // (verified for real — see `LiveStream.connectionCostUsd` doc), so
        // only the delta since this connection's last reported value is new
        // spend. Clamp at 0 in case of any float jitter/SDK quirk so a
        // decrease never subtracts from the persisted total.
        const rawTotalCostUsd = event.totalCostUsd ?? 0
        const deltaUsd = Math.max(0, rawTotalCostUsd - live.connectionCostUsd)
        live.connectionCostUsd = rawTotalCostUsd
        const costUpdated = this.store.addCost(sessionId, deltaUsd)
        if (costUpdated) {
          logger.info('session cost updated', {
            sessionId,
            deltaUsd,
            rawTotalCostUsd,
            totalCostUsd: costUpdated.totalCostUsd,
            usage: event.usage
          })
          this.sendLifecycle({ type: 'session.updated', session: costUpdated })
        }
        // fix-ever-connected-missed-session-started: also mark everConnected
        // here as a safety net. session_started is normally responsible for
        // this, but a race between the initializationResult() control-protocol
        // channel and an interrupt closing the SDK's input queue can cause the
        // system/init streamed message to never arrive, silently skipping
        // session_started. A completed result proves the CLI DID record a
        // conversation, so future reconnects can safely use resume() rather
        // than startFreshWithRetry. This is idempotent if session_started
        // already ran.
        if (!this.store.getSession(sessionId)?.everConnected) {
          this.store.markEverConnected(sessionId)
        }
        // Drain the turn queue before signalling idle — if a queued message
        // is dispatched here, it sets busy=true again and the renderer never
        // sees a brief idle flash between turns.
        const q = this.turnQueues.get(sessionId)
        if (q) q.inflightId = null
        const drained = this.drainTurnQueue(sessionId)
        if (!drained) this.sendTurnState(sessionId, false)
        void this.refreshSessionWorkspace(sessionId, false).catch(() => undefined)
        // token-usage-indicator: pull context usage directly from the SDK's
        // own query — `totalTokens` is full in-context usage; cap is the
        // effective window (`maxTokens`), not auto-compaction threshold or
        // modelUsage's raw `contextWindow`.
        void this.harness.getContextUsage(sessionId).then((ctx) => {
          if (ctx && ctx.contextWindow > 0) {
            this.sendTokenUsage(sessionId, ctx.totalTokens, ctx.contextWindow)
          }
        })
        if (event.isError) this.expirePendingPrompts(sessionId, live)
        // Only on the session's 2nd completed turn — not on every later turn or
        // after reconnect (turnCount is restored from the transcript, so >= 2
        // would re-summarize and overwrite the title on each post-reconnect message).
        if (live.turnCount === AUTO_NAME_STARTING_FROM_TURN) {
          void this.maybeAutoName(sessionId).catch((err) =>
            logger.warn('auto-naming failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
          )
        }
        return
      }

      case 'permission_denied': {
        const pending = live.pendingTools.get(event.toolUseId)
        if (pending) {
          const content: ToolCallContent = {
            ...pending.content,
            status: 'denied',
            output: event.message,
          }
          const updated = this.store.updateMessage(pending.messageId, {
            content: JSON.stringify(content),
            rawEvent: event,
          })
          if (updated) this.sendMessage(sessionId, updated)
          live.pendingTools.delete(event.toolUseId)
        }
        return
      }

      case 'model_refusal_fallback': {
        this.flushBuffer(sessionId, live)
        const content: TranscriptNoticeContent = {
          kind: 'transcript_notice',
          level: 'warning',
          label: 'Model',
          text: event.content || `Request refused; retrying on ${event.fallbackModel}.`,
        }
        const message = this.store.addMessage({
          sessionId,
          role: 'system',
          content: JSON.stringify(content),
          rawEvent: event,
        })
        this.sendMessage(sessionId, message)
        return
      }

      case 'model_refusal_no_fallback': {
        this.flushBuffer(sessionId, live)
        const content: TranscriptNoticeContent = {
          kind: 'transcript_notice',
          level: 'danger',
          label: 'Refused',
          text: event.content || 'Model declined this request. Edit your message and try again.',
        }
        const message = this.store.addMessage({
          sessionId,
          role: 'system',
          content: JSON.stringify(content),
          rawEvent: event,
        })
        this.sendMessage(sessionId, message)
        return
      }

      case 'conversation_reset': {
        this.wipeConversation(sessionId, event.newConversationId)
        return
      }

      case 'local_command_output': {
        const content: LocalCommandOutputContent = {
          kind: 'local_command_output',
          text: event.content,
        }
        const message = this.store.addMessage({
          sessionId,
          role: 'assistant',
          content: JSON.stringify(content),
          rawEvent: event,
        })
        this.sendMessage(sessionId, message)
        return
      }
    }

    this.applyHarnessUiSideEffects(sessionId, event)
  }

  /**
   * A turn can end in error (`result` event, `isError: true`) while a
   * permission/AskUserQuestion/plan prompt is still awaiting a response —
   * confirmed live (see `respondToPrompt`'s doc comment): the harness never
   * resolves `canUseTool` itself in this case, so without this cleanup the
   * card stays rendered as `pending` forever, and a later click on it throws
   * "Unknown or already-resolved prompt" (bug: silently swallowed by the
   * renderer). Mark each abandoned prompt `expired` so the card reflects
   * reality and stops offering dead buttons.
   */
  private formatTurnErrorMessage(event: Extract<HarnessEvent, { type: 'result' }>): string {
    if (event.errors && event.errors.length > 0) {
      return event.errors.map((item) => formatHarnessErrorForUser(item)).join('\n')
    }
    if (event.result) return formatHarnessErrorForUser(event.result)
    switch (event.subtype) {
      case 'error_max_turns':
        return 'Turn stopped: maximum turn limit reached.'
      case 'error_max_budget_usd':
        return 'Turn stopped: session budget limit reached.'
      case 'error_max_structured_output_retries':
        return 'Turn stopped: structured output could not be produced.'
      case 'error_during_execution':
        return 'Turn failed during execution.'
      default:
        return `Turn failed (${event.subtype || 'unknown'}).`
    }
  }

  private expirePendingPrompts(sessionId: string, live: LiveStream): void {
    if (live.pendingPrompts.size === 0) return
    for (const [requestId, pending] of live.pendingPrompts) {
      const expiredContent = { ...pending.content, status: 'expired' }
      const updated = this.store.updateMessage(pending.messageId, { content: JSON.stringify(expiredContent) })
      if (updated) this.sendMessage(sessionId, updated)
      logger.info('expired pending prompt after errored turn', { sessionId, requestId })
    }
    live.pendingPrompts.clear()
  }

  /**
   * Tool calls persisted as `running` cannot finish once the harness
   * connection is torn down (close, reconnect, interrupt) — `tool_call_end`
   * never arrives. Flip them to a terminal state so resume/reconnect does
   * not show a forever-spinning action chip.
   */
  private finalizeStaleRunningToolCalls(sessionId: string, live?: LiveStream): void {
    const disconnectedNote = '(Session disconnected before this tool finished.)'
    for (const message of this.store.listMessages(sessionId)) {
      const structured = parseStructuredContent(message.content)
      if (structured?.kind !== 'tool_call' || structured.status !== 'running') continue
      const content: ToolCallContent = {
        ...structured,
        status: 'interrupted',
        output: structured.output ?? disconnectedNote
      }
      const updated = this.store.updateMessage(message.id, { content: JSON.stringify(content) })
      if (updated) this.sendMessage(sessionId, updated)
    }
    live?.pendingTools.clear()
  }

  private finishThinkingBlock(sessionId: string, live: LiveStream, status: ThinkingBlockContent['status']): void {
    if (live.thinkingMessageId == null) return
    const content: ThinkingBlockContent = {
      kind: 'thinking_block',
      status,
      text: live.thinkingText,
      parentToolUseId: live.thinkingParentToolUseId,
      ...(live.thinkingEstimatedTokens != null ? { estimatedTokens: live.thinkingEstimatedTokens } : {}),
    }
    const updated = this.store.updateMessage(live.thinkingMessageId, { content: JSON.stringify(content) })
    if (updated) this.sendMessage(sessionId, updated)
    this.harnessUi.clearThinkingChrome(sessionId)
    this.sendSdkChrome(sessionId)
    live.thinkingMessageId = null
    live.thinkingText = ''
    live.thinkingParentToolUseId = null
    live.thinkingEstimatedTokens = undefined
  }

  private flushBuffer(sessionId: string, live: LiveStream): void {
    if (live.bufferMessageId == null) return
    const updated = this.store.updateMessage(live.bufferMessageId, { content: live.buffer })
    if (updated) this.sendMessage(sessionId, updated)
    live.buffer = ''
    live.bufferMessageId = null
  }

  // ── Auto-naming (background summarizer, Bug #93 regression guard) ────

  /**
   * Runs once on the session's 2nd completed turn (`AUTO_NAME_STARTING_FROM_TURN`).
   * Skipped when the user has manually renamed (`name_locked_by_user`). The write
   * path (`SessionStore.setAutoName`) also no-ops when locked as a belt-and-suspenders guard.
   */
  private async maybeAutoName(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return
    if (session.nameLockedByUser) {
      logger.info('auto-naming skipped: name locked by user', { sessionId })
      return
    }

    const early = this.store.listMessages(sessionId).slice(0, 6)
    const transcript = early.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)
    if (!transcript) return

    const host = this.resolveHostFromSession(session.hostname)
    const namingSession = await this.harness.start(`${AUTO_NAME_PROMPT}\n\nConversation:\n${transcript}`, {
      cwd: this.resolveHarnessCwd(session.projectPath, session.hostname, session.worktreePath),
      host
    })

    let title = ''
    for await (const event of namingSession.events) {
      if (event.type === 'result' && !event.isError && event.result) {
        title = clampSessionTitle(event.result)
      }
    }

    if (!title) return
    const updated = this.store.setAutoName(sessionId, title)
    if (updated && updated.name === title) {
      this.sendLifecycle({ type: 'session.updated', session: updated })
    }
  }

  /**
   * Gracefully interrupts every live claude-code session on app quit so SDK
   * teardown surfaces `interrupted` (not `error`) and mid-turn sessions get
   * {@link TURN_INTERRUPTED_NOTICE} on the next resume.
   */
  async shutdownAllHarnessSessionsForAppQuit(): Promise<void> {
    for (const [sessionId, liveStream] of this.live.entries()) {
      const turnInFlight =
        liveStream.busy || liveStream.bufferMessageId != null || liveStream.pendingTools.size > 0
      if (turnInFlight) {
        this.store.setPendingTurnInterruptedNotice(sessionId)
      }
    }
    const sessionIds = this.store
      .listActiveSessions()
      .filter((s) => s.mode === 'claude-code')
      .map((s) => s.id)
    await Promise.all(sessionIds.map((id) => this.harness.interrupt(id).catch(() => undefined)))
    // Let each session's `consume()` loop apply `interrupted` before the DB closes.
    await delay(750)
    for (const sessionId of sessionIds) {
      this.live.delete(sessionId)
      this.connecting.delete(sessionId)
      this.sendTurnState(sessionId, false)
    }
  }

  /**
   * Attempts to reconnect all active sessions on startup without blocking the
   * caller. Harness starts on each session are staggered per devpod host so one
   * host is not hit with every reconnect/preload at once. During preload the
   * opening session shows 'connecting'; other sessions stay usable.
   */
  startupReconnect(): void {
    const execFileAsync = promisify(execFile)
    const TMUX_TIMEOUT_MS = 8000

    const markStale = (sessionId: string): void => {
      this.getWindow()?.webContents.send('session:stale', { sessionId, stale: true })
    }

    const tmuxName = (s: SessionRecord) =>
      `atelier-${s.id.replace(/[^a-zA-Z0-9-]/g, '-')}`.slice(0, 50)

    for (const session of this.store.listActiveSessions()) {
      if (session.deletedAt) continue
      if (session.mode === 'terminal') {
        // Terminal sessions can't auto-reconnect — probe tmux and mark stale if dead.
        const name = tmuxName(session)
        const check = session.hostname
          ? execFileAsync('ssh', [...SSH_MUX_OPTS, session.hostname, 'tmux', 'has-session', '-t', name], { timeout: TMUX_TIMEOUT_MS })
          : execFileAsync('tmux', ['has-session', '-t', name], { timeout: TMUX_TIMEOUT_MS })
        check.catch(() => markStale(session.id))
        continue
      }

      // claude-code: attempt startup reconnect for recently-active sessions only.
      if (this.sessionIsStartupIdleEligible(session)) {
        if (!session.closedAt) {
          void this.closeSession(session.id)
        }
        logger.info('startupReconnect: skipping auto reconnect (session startup-idle)', {
          sessionId: session.id,
          lastActiveAt: session.lastActiveAt
        })
        continue
      }

      const sessionId = session.id
      if (this.live.has(sessionId) || this.harness.isActive(sessionId)) {
        continue
      }
      this.startupAutoReconnect.add(sessionId)
      this.pendingPanelPreload.add(sessionId)
      this.connecting.add(sessionId)
      this.sendStatus(sessionId)

      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? undefined

      scheduleHostStartupReconnect(session.hostname, 250, async () => {
        try {
          const harnessSession = await this.reconnectHarness(session, {
            permissionMode,
            model: modelSelection?.model,
            effort: modelSelection?.effort
          })
          this.finalizeStaleRunningToolCalls(sessionId)
          this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)))
          this.resetHarnessUiForSession(sessionId)
          this.sendStatus(sessionId)
          void this.consume(sessionId, harnessSession.events, this.bumpConsumeGeneration(sessionId))
        } catch {
          this.pendingPanelPreload.delete(sessionId)
          this.workspacePreloadInFlight.delete(sessionId)
          this.startupAutoReconnect.delete(sessionId)
          // Don't mark as stale — transient startup failures are common (timing,
          // SSH mux not ready, etc.). Revert to idle so the user can click to retry.
          this.connecting.delete(sessionId)
          this.sendStatus(sessionId)
        }
      })
    }
  }
}

function deriveDefaultName(projectPath: string, prompt?: string): string {
  if (prompt && prompt.trim()) {
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ')
    return words.length < prompt.trim().length ? `${words}…` : words
  }
  const base = projectPath.split('/').filter(Boolean).pop() ?? projectPath
  return base
}

/**
 * Mutates a pending interactive-prompt content object into its resolved
 * form (05-interactive-prompts) — mirrors `tool_call_end`'s
 * `{...pending.content, status: ...}` pattern above. Throws on a
 * kind/decision mismatch (e.g. a `plan` decision sent for a
 * `permission_request` card) since that can only mean a renderer bug.
 */
function applyDecision(
  content: PermissionRequestContent | AskUserQuestionContent | PlanProposedContent,
  decision: PromptDecision
): PermissionRequestContent | AskUserQuestionContent | PlanProposedContent {
  if (content.kind === 'permission_request' && decision.kind === 'permission') {
    return { ...content, status: decision.decision === 'allow' ? 'allowed' : 'denied', alwaysAllowed: decision.alwaysAllow }
  }
  if (content.kind === 'ask_user_question' && decision.kind === 'ask_user_question') {
    if ('cancelled' in decision && decision.cancelled) {
      return { ...content, status: 'cancelled' }
    }
    if ('answers' in decision) {
      return { ...content, status: 'answered', answers: decision.answers, freeText: decision.freeText }
    }
  }
  if (content.kind === 'plan_proposed' && decision.kind === 'plan') {
    const status = decision.decision === 'accept' ? 'accepted' : decision.decision === 'reject' ? 'rejected' : 'keep_planning'
    return { ...content, status }
  }
  throw new Error(`Prompt decision kind "${decision.kind}" does not match pending prompt kind "${content.kind}"`)
}

/** Translates the renderer-facing `PromptDecision` into the harness's own `PromptResponse` shape (kept as separate types — see PromptDecision's doc comment). */
function toHarnessPromptResponse(decision: PromptDecision): PromptResponse {
  return decision
}

/** Field-wise equality for `ModelSelection` (10f-enrichment-model-effort-picker) — `undefined` on both sides counts as equal, so an override that only sets one field doesn't spuriously read as "changed" against a `Map` entry missing entirely. */
function modelSelectionsEqual(a?: ModelSelection, b?: ModelSelection): boolean {
  return (a?.model ?? undefined) === (b?.model ?? undefined) && (a?.effort ?? undefined) === (b?.effort ?? undefined)
}
