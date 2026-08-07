import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HarnessDriver, HarnessEvent, HarnessSession, HarnessStartOptions, PromptResponse, RemoteHost } from '../harness/types'
import { logger } from '../logger'
import type {
  CreateSessionOptions,
  ImageAttachment,
  MessageRecord,
  ModelSelection,
  MessageSearchHit,
  PermissionModeValue,
  PromptDecision,
  RemoteHostOption,
  SessionGroupEvent,
  SessionGroupRecord,
  SessionLifecycleEvent,
  SessionRecord,
  SessionStatus,
  SlashCommandInfo
} from '../../shared/session-types'
import type { SessionWorkspacePayload } from '../../shared/session-workspace-types'
import { TURN_INTERRUPTED_NOTICE } from '../../shared/session-types'
import { defaultClaudeModelFromConfig, defaultClaudeEffortFromConfig } from '../../shared/config'
import { loadConfig } from '../config'
import type {
  AskUserQuestionContent,
  CompactionContent,
  ImageAttachmentContent,
  PermissionRequestContent,
  PlanProposedContent,
  ToolCallContent,
  ThinkingBlockContent,
  TodoUpdateContent
} from '../../shared/chat-content'
import { parseStructuredContent } from '../../shared/chat-content'
import type { SessionStore } from './store'
import { suggestProjectPaths as computeProjectPathSuggestions } from './project-path-suggest'
import { worktreeRootFromConfig } from '../../shared/worktree-path'
import { homeDirForWorktreeHost } from './worktree-home'
import { createWorktree, removeWorktree } from './worktree'
import { warmRemoteGitHost } from '../panels/git'
import { handleFileEditToolCompleted } from './session-changes-cap'
import { WorkspaceService } from './workspace-service'
import { applyBashCdCommands } from './harness-cwd'
import { SessionHarnessUiState } from './session-harness-ui'
import type {
  SessionAuthStatusEvent,
  SessionBackgroundTasksEvent,
  SessionRateLimitEvent,
  SessionSdkChromeEvent,
  SessionToastEvent,
} from '../../shared/harness-ui-types'
import type { LocalCommandOutputContent, TranscriptNoticeContent } from '../../shared/chat-content'
import { completeLinkedDailyTask, linkDailyTaskToSession } from '../daily-note-session-link'

const AUTO_NAME_STARTING_FROM_TURN = 2
const AUTO_NAME_PROMPT = 'Summarize this conversation topic in under 6 words. Reply with ONLY the title, no punctuation, no quotes.'

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
  }
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
  /** Sessions currently between a triggered `reconnect()` and the live harness connection actually being (re)established — see `getStatus()`'s 'connecting' case (fix-session-resume-stale-sigterm-and-no-connect-indicator). */
  private readonly connecting = new Set<string>()
  /** Sessions currently being set up with an async worktree creation — see `getStatus()`'s 'creating-worktree' case. */
  private readonly creatingWorktree = new Set<string>()
  /** Open claude-code sessions left disconnected on launch due to 1h+ inactivity (session-startup-idle). */
  private readonly startupIdle = new Set<string>()
  /** After reconnect(), the first harness event triggers panel preload in the renderer. */
  private readonly pendingPanelPreload = new Set<string>()
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

  private readonly harnessUi = new SessionHarnessUiState()

  private workspace: WorkspaceService | null = null

  setWorkspaceService(workspace: WorkspaceService): void {
    this.workspace = workspace
  }

  getWorkspaceService(): WorkspaceService | null {
    return this.workspace
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

  async refreshSessionWorkspace(sessionId: string, force: boolean): Promise<SessionWorkspacePayload | null> {
    const session = this.getSession(sessionId)
    if (!session || session.mode !== 'claude-code' || !this.workspace) return null
    return this.workspace.refreshWorkspace(session, force)
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

  /** 'creating-worktree' while the async worktree setup is in flight; 'connecting' while `reconnect()` is in flight; 'startup-idle' when launch skipped auto reconnect due to 1h+ inactivity; 'working'/'waiting' for any session with a live entry this app run; 'idle' otherwise. */
  getStatus(sessionId: string): SessionStatus {
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
      if (session.mode !== 'claude-code') continue
      if (!this.sessionIsStartupIdleEligible(session)) continue
      this.closeSession(session.id)
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

  private sendReconnectComplete(sessionId: string): void {
    this.getWindow()?.webContents.send('session:reconnectComplete', { sessionId })
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
    this.closeSession(sessionId)
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

  private sendHarnessCwd(sessionId: string, cwd: string): void {
    this.getWindow()?.webContents.send('session:harnessCwd', { sessionId, cwd })
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
        groupId: opts.groupId ?? null
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
    let effectiveCwd = opts.projectPath
    const wantWorktree = !!opts.useWorktree
    const hostname = hostOption?.sshHost

    if (wantWorktree) {
      const { randomUUID } = await import('node:crypto')
      const allocatedId = randomUUID()

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
          worktreePath: null
        })
      )
      this.sendLifecycle({ type: 'session.created', session })
      if (session.hostname) void warmRemoteGitHost(session.hostname)

      this.seedDefaultModelSelection(allocatedId)

      // Mark as 'creating-worktree' so the sidebar row shows the pending
      // state (50% opacity, pulsing grey dot, "Setting up worktree…" label).
      this.creatingWorktree.add(allocatedId)
      this.sendStatus(allocatedId)

      // Fire worktree creation + harness start asynchronously so createSession
      // returns immediately (the modal closes, the row appears).
      void this.setupWorktreeAsync(allocatedId, opts, host, hostOption, hostname)

      return session
    }

    const harnessSession = await this.harness.start(opts.prompt ?? '', {
      cwd: effectiveCwd,
      host,
      // Real interactive chat session: stays connected past its first turn
      // so a later `sendUserMessage` can inject live via `streamInput()`
      // instead of always reconnecting — see `HarnessStartOptions.keepAlive`.
      keepAlive: true,
      ...this.defaultHarnessModelOpts(),
      ...(opts.planMode ? { permissionMode: 'plan' as const } : {})
    })
    if (opts.planMode) {
      this.permissionModes.set(harnessSession.sessionId, 'plan')
      this.store.setPermissionMode(harnessSession.sessionId, 'plan')
    }

    const session = this.decorate(
      this.store.createSession({
        id: harnessSession.sessionId,
        name: defaultName,
        projectPath: opts.projectPath,
        mode: 'claude-code',
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null,
        worktreePath: null
      })
    )

    if (opts.prompt) {
      const userMessage = this.store.addMessage({ sessionId: session.id, role: 'user', content: opts.prompt })
      this.sendMessage(session.id, userMessage)
    }

    this.sendLifecycle({ type: 'session.created', session })
    if (session.hostname) void warmRemoteGitHost(session.hostname)
    this.seedDefaultModelSelection(session.id)
    this.live.set(session.id, newLiveStream())
    this.resetHarnessUiForSession(session.id)
    this.pendingPanelPreload.add(session.id)
    // A real turn is about to run only if there's an initial prompt to
    // process — an empty-prompt create just opens the connection.
    if (opts.prompt) {
      this.live.get(session.id)!.busy = true
      this.sendStatus(session.id)
      this.sendTurnState(session.id, true)
    }
    void this.consume(session.id, harnessSession.events)
    return session
  }

  // ── Resume ──────────────────────────────────────────────────────────

  /**
   * Async worktree setup for `createSession` (use-worktree): runs after the
   * session record has already been created and `session:created` has been
   * broadcast so the sidebar row is visible in the 'creating-worktree' state.
   * On success: persists the worktree path, removes the 'creating-worktree'
   * flag, starts the harness, and transitions the row to its live status.
   * On failure: cleans up the creatingWorktree flag, deletes the session row,
   * and broadcasts `session:deleted` so the row disappears from the sidebar.
   */
  private async setupWorktreeAsync(
    sessionId: string,
    opts: CreateSessionOptions,
    host: RemoteHost | undefined,
    hostOption: RemoteHostOption | undefined,
    hostname: string | undefined
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
      logger.info('setupWorktreeAsync: worktree created', { sessionId, worktreePath })

      // Persist the worktree path now that we have it.
      this.store.setWorktreePath(sessionId, worktreePath)

      const harnessOpts = {
        cwd: worktreePath,
        host,
        keepAlive: true as const,
        ...this.defaultHarnessModelOpts(),
        ...(opts.planMode ? { permissionMode: 'plan' as const } : {})
      }
      const harnessSession = await this.harness.startWithId(sessionId, opts.prompt ?? '', harnessOpts)
      if (opts.planMode) {
        this.permissionModes.set(harnessSession.sessionId, 'plan')
        this.store.setPermissionMode(harnessSession.sessionId, 'plan')
      }

      if (opts.prompt) {
        const userMessage = this.store.addMessage({ sessionId, role: 'user', content: opts.prompt })
        this.sendMessage(sessionId, userMessage)
      }

      // Remove creating-worktree state and transition to live.
      this.creatingWorktree.delete(sessionId)
      this.live.set(sessionId, newLiveStream())
      this.resetHarnessUiForSession(sessionId)
      this.pendingPanelPreload.add(sessionId)
      if (opts.prompt) {
        this.live.get(sessionId)!.busy = true
      }
      this.sendStatus(sessionId)
      if (opts.prompt) this.sendTurnState(sessionId, true)
      void this.consume(sessionId, harnessSession.events)
    } catch (err) {
      logger.warn('setupWorktreeAsync: failed, removing session', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      this.creatingWorktree.delete(sessionId)
      // Best-effort worktree cleanup — the path may not exist if createWorktree
      // itself failed, so ignore errors here.
      const stored = this.store.getSession(sessionId)
      if (stored?.worktreePath) {
        void removeWorktree(stored.worktreePath, sessionId, stored.projectPath, hostname).catch(() => undefined)
      }
      this.store.deleteSession(sessionId)
      this.sendLifecycle({ type: 'session.deleted', sessionId })
    }
  }

  /** Reopens a closed session and returns it + its full stored transcript synchronously (renderer renders this BEFORE the live reconnect below happens). */
  resumeSnapshot(sessionId: string): { session: SessionRecord; messages: MessageRecord[] } {
    const existing = this.store.getSession(sessionId)
    if (!existing) throw new Error(`Unknown session: ${sessionId}`)
    const session = this.decorate(this.store.reopenSession(sessionId) ?? existing)
    this.finalizeStaleRunningToolCalls(sessionId)
    this.deliverPendingTurnInterruptedNotice(sessionId)
    const messages = this.store.listMessages(sessionId)
    this.sendLifecycle({ type: 'session.resumed', session })
    return { session, messages }
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
      cwd: session.worktreePath ?? session.projectPath,
      host,
      keepAlive: true,
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {})
    }
    if (!session.everConnected) {
      logger.info('reconnectHarness: session never had a real connection, starting fresh (not resume())', {
        sessionId: session.id
      })
      return {
        sessionId: session.id,
        events: this.startFreshWithRetry(session, startOpts, opts.initialPrompt)
      }
    }
    const harnessSession = await this.harness.resume(session.id, startOpts)
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
    startOpts: { cwd: string; host?: RemoteHost; keepAlive: boolean; permissionMode?: PermissionModeValue; model?: string; effort?: ModelSelection['effort'] },
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
    startOpts: { cwd: string; host?: RemoteHost; keepAlive: boolean; permissionMode?: PermissionModeValue; model?: string; effort?: ModelSelection['effort'] },
    initialPrompt?: string
  ): AsyncGenerator<HarnessEvent, void, void> {
    const MAX_ATTEMPTS = 4
    const RETRY_DELAYS_MS = [1500, 3000, 5000]
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fresh = await this.harness.startWithId(session.id, initialPrompt ?? '', startOpts)
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
    const session = this.store.getSession(sessionId)
    if (!session || session.mode !== 'claude-code') return
    // Don't race with setupWorktreeAsync — while the worktree is being created
    // the harness will be started by that path once creation completes.
    if (this.creatingWorktree.has(sessionId)) return
    // Already live (e.g. connected by startupReconnect) — nothing to do.
    if (this.live.has(sessionId)) return
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
      // NOT cleared here — `harness.resume()` resolving only means the SDK
      // `query()` call was constructed, not that the subprocess has actually
      // spawned/handshaken yet. `connecting` is cleared in applyEvent() the
      // moment the first real harness event arrives (see its comment).
      this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)))
      this.resetHarnessUiForSession(sessionId)
      this.sendStatus(sessionId)
      void this.consume(sessionId, harnessSession.events)
    } catch (err) {
      this.connecting.delete(sessionId)
      this.pendingPanelPreload.delete(sessionId)
      // A genuine reconnect failure must still surface distinctly — this is
      // unrelated to Part A's fix above (which only suppresses the bogus
      // error a graceful CLOSE causes); reportHarnessFailure logs it AND
      // persists a visible system-role error message, same as before.
      this.reportHarnessFailure(sessionId, 'reconnect', err)
      throw err
    }
  }

  // ── Send message into a live (or reconnected) session ──────────────

  /**
   * Sends a follow-up user message.
   *
   * `ClaudeAgentSdkHarness.normalize()` used to complete its event generator
   * after every turn's terminal `result`, which tore down that turn's
   * internal session entry — so a bare `streamInput()` call would silently
   * no-op for any message after the first turn, and every follow-up here
   * had to go through `resume()` (a fresh `--resume <id>` reconnect) even
   * when the previous turn's process was still sitting right there. Fixed
   * in this task (04-composer-core) after verifying against the real SDK
   * (see `normalize()`'s comment) that the same `query()`/subprocess
   * happily accepts further turns pushed into its still-open input queue
   * with no reconnect — including a message pushed WHILE the current turn
   * is still streaming, which the SDK simply folds into that turn's own
   * response instead of queuing it for later.
   *
   * So: if the harness reports this session `isActive` (its generator
   * hasn't returned — covers both "mid-turn, still streaming" and "idle,
   * connected, between turns"), this pushes straight into the live queue
   * via `streamInput()` and returns — the ALREADY-RUNNING `consume()` loop
   * from whenever this session last started/reconnected keeps delivering
   * this turn's events, live, with no new subprocess. Only a session with
   * no live harness entry at all (freshly reopened after being properly
   * closed/interrupted, or after an app relaunch) falls back to the
   * `resume()` reconnect path. Turn-count bookkeeping (for auto-naming) is
   * preserved across a `resume()` reconnect — it only resets on session
   * close or a real app relaunch.
   */
  async sendUserMessage(sessionId: string, text: string, override?: ModelSelection, image?: ImageAttachment): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    // Persisted content is the plain-text string in the common (no image)
    // case, unchanged from before this task. With an image attached, it's
    // JSON-encoded as an ImageAttachmentContent instead — same
    // "one row, tagged with `kind`" pattern every other StructuredContent
    // kind already uses — purely so the transcript can render a thumbnail;
    // the SDK call itself (below) carries the real image bytes separately.
    const content: string = image
      ? JSON.stringify({ kind: 'image_attachment', mimeType: image.mimeType, data: image.data, text } satisfies ImageAttachmentContent)
      : text
    const userMessage = this.store.addMessage({ sessionId, role: 'user', content })
    this.touchLastActive(sessionId)
    this.sendPromptSuggestion(sessionId, null)
    this.sendMessage(sessionId, userMessage)

    if (session.mode !== 'claude-code') return
    this.sendTurnState(sessionId, true)
    try {
      // 10f-enrichment-model-effort-picker: a caller (the composer's model
      // picker) can ask for THIS message onward to use a different
      // model/effort than the session's live connection is currently
      // running with. `override === undefined` (the composer never touched
      // the picker) preserves every pre-existing caller's behavior exactly.
      // A genuinely NEW selection, though, can only take effect on a fresh
      // start()/resume() call (see HarnessStartOptions.model/.effort) — an
      // already-open streaming-input query has no live setter for either —
      // so if the session is currently live, it must be torn down first via
      // `harness.interrupt()` (verified safe to immediately follow with a
      // resume(): see the pump()/finally race comment in
      // claude-agent-sdk-harness.ts) before falling into the same
      // `resume()` path already used below for a session with no live
      // connection at all.
      const previousSelection = this.modelSelections.get(sessionId)
      const selectionChanged = override !== undefined && !modelSelectionsEqual(override, previousSelection)
      if (selectionChanged) {
        logger.info('sendUserMessage: model/effort selection changed, applying from next turn', {
          sessionId,
          previous: previousSelection,
          next: override
        })
        this.modelSelections.set(sessionId, override)
        this.store.setModelSelection(sessionId, override)
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
        logger.info('sendUserMessage: live injection (streamInput, no resume)', { sessionId })
        await this.harness.streamInput(sessionId, text, image)
        // This reuses the EXISTING `consume()` loop/live entry from whenever
        // the session last started/reconnected — no new `live.busy = true`
        // assignment happens anywhere else on this path (unlike the
        // create/resume paths below, which each set it right after standing
        // up their own live entry). Left unset, the dot stays stuck on
        // whatever it last was ('waiting', rendered purple) for this entire
        // new turn — including through any permission/AskUserQuestion/plan
        // prompt it raises and the `respondToPrompt` that answers it — even
        // though the harness is genuinely running again. Set it explicitly
        // here so the dot flips to 'working' immediately, same as every
        // other turn-start path.
        const liveEntry = this.live.get(sessionId)
        if (liveEntry) {
          liveEntry.busy = true
          this.sendStatus(sessionId)
        }
        return
      }
      logger.info('sendUserMessage: no live harness session, reconnecting via resume()', { sessionId })
      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? undefined
      // fix-send-message-dropped-on-never-connected: for sessions that have
      // never connected, startFreshWithRetry is a lazy async generator —
      // this.sessions.set() (and therefore a valid queue to push to) only
      // happens inside startWithId, which runs when consume() first pulls from
      // the generator. Calling streamInput() before that would push to the OLD
      // closed queue (a silent no-op). Instead, pass the text as initialPrompt
      // so it's seeded into the new queue at startWithId/launch time.
      const needsInitialPrompt = !session.everConnected
      const harnessSession = await this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort,
        ...(needsInitialPrompt ? { initialPrompt: text } : {})
      })
      if (!needsInitialPrompt) {
        await this.harness.streamInput(sessionId, text, image)
      }
      const previousTurnCount = this.live.get(sessionId)?.turnCount ?? 0
      const previousLive = this.live.get(sessionId)
      this.finalizeStaleRunningToolCalls(sessionId, previousLive)
      this.live.set(sessionId, newLiveStream(previousTurnCount))
      this.resetHarnessUiForSession(sessionId)
      this.live.get(sessionId)!.busy = true
      this.sendStatus(sessionId)
      void this.consume(sessionId, harnessSession.events)
    } catch (err) {
      this.sendTurnState(sessionId, false)
      this.reportHarnessFailure(sessionId, 'sendUserMessage', err)
      throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.harness.interrupt(sessionId)
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
      content: `Error: ${errorMessage}`
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
    const forked = this.store.forkSession(sourceId)
    if (!forked) throw new Error(`Unknown session: ${sourceId}`)
    this.sendLifecycle({ type: 'session.forked', session: forked, sourceId })
    return forked
  }

  restartSession(sourceId: string): SessionRecord {
    const forked = this.forkSession(sourceId)
    this.closeSession(sourceId)
    return forked
  }

  // ── Close / Delete / Rename / Pin ────────────────────────────────────

  closeSession(sessionId: string): SessionRecord {
    this.markInterruptedTurnNoticeIfBusy(sessionId)
    void this.harness.interrupt(sessionId).catch(() => undefined)
    const live = this.live.get(sessionId)
    this.finalizeStaleRunningToolCalls(sessionId, live)
    this.live.delete(sessionId)
    // A session can be closed again while a previous reconnect() is still in
    // flight (e.g. rapid resume/close) — don't leave a stale 'connecting'
    // pill visible for a session that's no longer even open.
    this.connecting.delete(sessionId)
    this.creatingWorktree.delete(sessionId)
    this.pendingPanelPreload.delete(sessionId)
    this.workspace?.evictSession(sessionId)
    this.sendTurnState(sessionId, false)
    const session = this.store.closeSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
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

  deleteSession(sessionId: string): void {
    const session = this.store.getSession(sessionId)
    // use-worktree: remove the session's isolated git worktree and its branch
    // before deleting the DB row (which is where the path is stored). Errors
    // are caught and logged — a failed cleanup must never block deletion.
    if (session?.worktreePath) {
      const hostname = session.hostname ? this.hosts.resolveByHostname(session.hostname)?.sshHost : undefined
      void removeWorktree(session.worktreePath, sessionId, session.projectPath, hostname).catch((err) => {
        logger.warn('deleteSession: worktree removal failed (ignored)', {
          sessionId,
          worktreePath: session.worktreePath,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
    this.live.delete(sessionId)
    this.connecting.delete(sessionId)
    this.creatingWorktree.delete(sessionId)
    this.workspace?.evictSession(sessionId)
    this.store.deleteSession(sessionId)
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

  setNotes(sessionId: string, notes: string): SessionRecord {
    const session = this.store.setNotes(sessionId, notes)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.updated', session })
    return session
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
    this.store.deleteGroup(groupId)
    this.sendGroupEvent({ type: 'group.deleted', groupId })
    // Member sessions' group_id changed to NULL underneath them — the
    // sidebar needs to move them into "Ungrouped", so refresh via a normal
    // lifecycle-style broadcast too (cheapest correct thing, matches how
    // every other cross-cutting session change is surfaced).
    for (const session of this.store.listActiveSessions()) {
      if (session.groupId === null) this.sendLifecycle({ type: 'session.updated', session })
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

  private async consume(sessionId: string, events: AsyncGenerator<HarnessEvent, void, void>): Promise<void> {
    for await (const event of events) {
      this.applyEvent(sessionId, event)
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
    const live = this.live.get(sessionId) ?? newLiveStream()
    this.live.set(sessionId, live)
    // Any real event arriving from the harness means the live connection is
    // genuinely established — clears the 'connecting' status (and its
    // topbar pill) here rather than the instant `harness.resume()`'s promise
    // resolves in reconnect(), since that resolves as soon as the SDK's
    // `query()` call is constructed, well before the underlying subprocess
    // has actually spawned/handshaken (verified for real: `session_started`
    // — from the SDK's own system/init message — routinely arrives 1-3s
    // after `resume()` returns). Clearing on the FIRST event of ANY type
    // (not just 'session_started') is also a safety net against a session
    // that fails before ever producing one.
    if (this.connecting.has(sessionId)) {
      this.connecting.delete(sessionId)
      this.sendStatus(sessionId)
    }

    const needsWorkspacePreload = this.pendingPanelPreload.delete(sessionId)
    if (needsWorkspacePreload) {
      this.startupAutoReconnect.delete(sessionId)
      const row = this.store.getSession(sessionId)
      if (this.workspace && row?.mode === 'claude-code') {
        this.connecting.add(sessionId)
        this.sendStatus(sessionId)
        void this.workspace.completeSessionOpen(this.decorate(row)).finally(() => {
          this.connecting.delete(sessionId)
          this.sendStatus(sessionId)
          this.sendReconnectComplete(sessionId)
        })
      } else {
        this.sendReconnectComplete(sessionId)
      }
    }

    switch (event.type) {
      case 'thinking_block_start': {
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
            const workspaceRoot = session.worktreePath ?? session.projectPath
            const workspacePath = workspaceRoot
            void handleFileEditToolCompleted(
              this.store,
              sessionId,
              workspaceRoot,
              workspacePath,
              session.hostname,
              pending.content.name,
              pending.content.input
            ).then((cap) => {
              this.workspace?.patchSessionChangesCap(sessionId, cap)
            })
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

      case 'prompt_suggestion':
        logger.info('harness event: prompt_suggestion', { sessionId, length: event.suggestion.length })
        this.sendPromptSuggestion(sessionId, event.suggestion)
        return

      case 'permission_request': {
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
        return
      }

      case 'error': {
        this.flushBuffer(sessionId, live)
        const message = this.store.addMessage({
          sessionId,
          role: 'system',
          content: `Error: ${event.message}`,
          rawEvent: event
        })
        this.sendMessage(sessionId, message)
        live.busy = false
        this.sendStatus(sessionId)
        this.sendTurnState(sessionId, false)
        return
      }

      case 'interrupted':
        this.flushBuffer(sessionId, live)
        this.finalizeStaleRunningToolCalls(sessionId, live)
        live.busy = false
        this.sendStatus(sessionId)
        logger.info('harness event: interrupted (terminal)', { sessionId })
        this.sendTurnState(sessionId, false)
        return

      case 'result': {
        this.flushBuffer(sessionId, live)
        live.turnCount += 1
        live.busy = false
        this.sendPromptSuggestion(sessionId, null)
        this.sendStatus(sessionId)
        logger.info('harness event: result (turn complete)', { sessionId, turnCount: live.turnCount, isError: event.isError })
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
        this.sendTurnState(sessionId, false)
        // token-usage-indicator: pull context usage directly from the SDK's
        // own query — gives us `totalTokens` (all categories: user message,
        // system prompt, MCP tools, cache reads, etc.) and `autoCompactThreshold`
        // (the real cap before auto-compaction fires, which is smaller than
        // the model's full context window). Falls back to modelUsage math if
        // the session is no longer live.
        void this.harness.getContextUsage(sessionId).then((ctx) => {
          if (ctx && ctx.autoCompactThreshold) {
            this.sendTokenUsage(sessionId, ctx.totalTokens, ctx.autoCompactThreshold)
          } else if (event.modelUsage) {
            const entries = Object.values(event.modelUsage)
            if (entries.length > 0) {
              const inputTokens = entries.reduce(
                (sum, m) => sum + m.inputTokens + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0),
                0
              )
              const contextWindow = Math.max(...entries.map((m) => m.contextWindow))
              if (contextWindow > 0) this.sendTokenUsage(sessionId, inputTokens, contextWindow)
            }
          }
        })
        if (event.isError) this.expirePendingPrompts(sessionId, live)
        if (live.turnCount >= AUTO_NAME_STARTING_FROM_TURN) {
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
   * Always actually runs the summarizer harness call when there's a
   * transcript, regardless of `name_locked_by_user` — the lock is enforced
   * exclusively at the write path (`SessionStore.setAutoName`), not by
   * skipping the call here. This mirrors Playground's real Bug #93 exactly
   * (the summarizer DID run after a manual rename; the missing piece was a
   * guard on the write) and makes the regression test meaningful: it proves
   * the guard holds under an actual attempted overwrite, not just that the
   * summarizer happened not to be invoked.
   */
  private async maybeAutoName(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return

    const early = this.store.listMessages(sessionId).slice(0, 6)
    const transcript = early.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)
    if (!transcript) return

    const host = this.resolveHostFromSession(session.hostname)
    const namingSession = await this.harness.start(`${AUTO_NAME_PROMPT}\n\nConversation:\n${transcript}`, {
      cwd: session.projectPath,
      host
    })

    let title = ''
    for await (const event of namingSession.events) {
      if (event.type === 'result' && !event.isError && event.result) {
        title = event.result.trim().replace(/^["'“”]+|["'“”]+$/g, '')
      }
    }

    if (!title) return
    // SessionStore.setAutoName is the ONLY place a name is ever auto-applied,
    // and it internally no-ops when name_locked_by_user is true — this call
    // happens unconditionally, proving the guard (not the caller) is what
    // stops the overwrite.
    const updated = this.store.setAutoName(sessionId, title)
    if (session.nameLockedByUser) {
      logger.info('auto-naming attempted but blocked: name is locked by user', { sessionId, attemptedTitle: title })
      return
    }
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
   * Attempts to reconnect all active sessions on startup, concurrently and
   * without blocking the caller. During reconnect each session shows as
   * 'connecting' (blinking grey). On success it transitions to 'waiting'
   * (purple). On failure it is pushed to 'session:stale' (steady grey) with
   * no error written to the transcript — startup failures are silent.
   * Terminal-mode sessions can't auto-reconnect (they need a pty attach), so
   * they are probed via `tmux has-session` instead and marked stale if dead.
   */
  startupReconnect(): void {
    const execFileAsync = promisify(execFile)
    const SSH_MUX_OPTS = ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/atelier-ssh-%C', '-o', 'ControlPersist=300']
    const TMUX_TIMEOUT_MS = 8000

    const markStale = (sessionId: string): void => {
      this.getWindow()?.webContents.send('session:stale', { sessionId, stale: true })
    }

    const tmuxName = (s: SessionRecord) =>
      `atelier-${s.id.replace(/[^a-zA-Z0-9-]/g, '-')}`.slice(0, 50)

    for (const session of this.store.listActiveSessions()) {
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
          this.closeSession(session.id)
        }
        logger.info('startupReconnect: skipping auto reconnect (session startup-idle)', {
          sessionId: session.id,
          lastActiveAt: session.lastActiveAt
        })
        continue
      }

      const sessionId = session.id
      this.startupAutoReconnect.add(sessionId)
      this.pendingPanelPreload.add(sessionId)
      this.connecting.add(sessionId)
      this.sendStatus(sessionId)

      const permissionMode = this.permissionModes.get(sessionId) ?? session.permissionMode
      const modelSelection = this.modelSelections.get(sessionId) ?? session.modelSelection ?? undefined

      this.reconnectHarness(session, {
        permissionMode,
        model: modelSelection?.model,
        effort: modelSelection?.effort,
      }).then((harnessSession) => {
        this.finalizeStaleRunningToolCalls(sessionId)
        this.live.set(sessionId, newLiveStream(this.initialTurnCountForReconnect(sessionId)))
      this.resetHarnessUiForSession(sessionId)
        this.sendStatus(sessionId)
        void this.consume(sessionId, harnessSession.events)
      }).catch(() => {
        this.pendingPanelPreload.delete(sessionId)
        this.startupAutoReconnect.delete(sessionId)
        // Don't mark as stale — transient startup failures are common (timing,
        // SSH mux not ready, etc.). Revert to idle so the user can click to retry.
        this.connecting.delete(sessionId)
        this.sendStatus(sessionId)
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
    return { ...content, status: 'answered', answers: decision.answers, freeText: decision.freeText }
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
