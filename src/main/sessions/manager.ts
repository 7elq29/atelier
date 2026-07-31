import type { BrowserWindow } from 'electron'
import type { HarnessDriver, HarnessEvent, RemoteHost } from '../harness/types'
import { logger } from '../logger'
import type {
  CreateSessionOptions,
  MessageRecord,
  RemoteHostOption,
  SessionLifecycleEvent,
  SessionRecord
} from '../../shared/session-types'
import type { CompactionContent, ToolCallContent, TodoUpdateContent } from '../../shared/chat-content'
import type { SessionStore } from './store'

const AUTO_NAME_STARTING_FROM_TURN = 2
const AUTO_NAME_PROMPT = 'Summarize this conversation topic in under 6 words. Reply with ONLY the title, no punctuation, no quotes.'

/** Bookkeeping for one still-running tool call, keyed by its toolUseId. */
interface PendingToolCall {
  messageId: number
  content: ToolCallContent
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
  /** Tool calls started but not yet ended, keyed by toolUseId. */
  pendingTools: Map<string, PendingToolCall>
}

function newLiveStream(turnCount = 0): LiveStream {
  return { buffer: '', bufferMessageId: null, turnCount, pendingTools: new Map() }
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

  constructor(
    private readonly store: SessionStore,
    private readonly harness: HarnessDriver,
    private readonly hosts: RemoteHostResolver,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  listActive(): SessionRecord[] {
    return this.store.listActiveSessions()
  }

  listHistory(): SessionRecord[] {
    return this.store.listHistorySessions()
  }

  listMessages(sessionId: string): MessageRecord[] {
    return this.store.listMessages(sessionId)
  }

  listHosts(): RemoteHostOption[] {
    return this.hosts.list()
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

  async createSession(opts: CreateSessionOptions): Promise<SessionRecord> {
    const host = this.resolveHost(opts.hostId)
    const hostOption = opts.hostId === 'local' ? undefined : this.hosts.resolve(opts.hostId)
    const defaultName = deriveDefaultName(opts.projectPath, opts.prompt)

    if (opts.mode === 'terminal') {
      // Terminal-only sessions have no agent/harness involvement in this task
      // (real pty/shell integration is a later feature) — just a row so it
      // shows up in the sidebar and can be closed/renamed/deleted like any
      // other session.
      const session = this.store.createSession({
        name: defaultName,
        projectPath: opts.projectPath,
        mode: 'terminal',
        hostname: hostOption?.sshHost ?? null,
        groupId: opts.groupId ?? null
      })
      this.sendLifecycle({ type: 'session.created', session })
      return session
    }

    const harnessSession = await this.harness.start(opts.prompt ?? '', {
      cwd: opts.projectPath,
      host
    })

    const session = this.store.createSession({
      id: harnessSession.sessionId,
      name: defaultName,
      projectPath: opts.projectPath,
      mode: 'claude-code',
      hostname: hostOption?.sshHost ?? null,
      groupId: opts.groupId ?? null
    })

    if (opts.prompt) {
      const userMessage = this.store.addMessage({ sessionId: session.id, role: 'user', content: opts.prompt })
      this.sendMessage(session.id, userMessage)
    }

    this.sendLifecycle({ type: 'session.created', session })
    this.live.set(session.id, newLiveStream())
    void this.consume(session.id, harnessSession.events)
    return session
  }

  // ── Resume ──────────────────────────────────────────────────────────

  /** Reopens a closed session and returns it + its full stored transcript synchronously (renderer renders this BEFORE the live reconnect below happens). */
  resumeSnapshot(sessionId: string): { session: SessionRecord; messages: MessageRecord[] } {
    const existing = this.store.getSession(sessionId)
    if (!existing) throw new Error(`Unknown session: ${sessionId}`)
    const session = this.store.reopenSession(sessionId) ?? existing
    const messages = this.store.listMessages(sessionId)
    this.sendLifecycle({ type: 'session.resumed', session })
    return { session, messages }
  }

  /** Reconnects the live harness session on top of the already-rendered transcript. No-op for terminal sessions. */
  async reconnect(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session || session.mode !== 'claude-code') return
try {
      const host = this.resolveHostFromSession(session.hostname)
      const harnessSession = await this.harness.resume(sessionId, { cwd: session.projectPath, host })
      this.live.set(sessionId, newLiveStream())
      void this.consume(sessionId, harnessSession.events)
    } catch (err) {
      this.reportHarnessFailure(sessionId, 'reconnect', err)
      throw err
    }
  }

  // ── Send message into a live (or reconnected) session ──────────────

  /**
   * Sends a follow-up user message. The harness's own event generator
   * completes after each turn's terminal `result` (by design — see
   * claude-agent-sdk-harness.ts's `normalize()`, verified against
   * 01-harness-abstraction's own one-shot probes), which tears down that
   * turn's internal session entry. A bare `streamInput()` call would
   * therefore silently no-op for any message after the first turn — so
   * every follow-up here goes through `resume()` (the SDK's own
   * `--resume <id>` mechanism) to reconnect, then immediately pushes the
   * new message into that fresh connection before consuming its events.
   * Turn-count bookkeeping (for auto-naming) is preserved across these
   * reconnects — it only resets on session close or a real app relaunch.
   */
  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const userMessage = this.store.addMessage({ sessionId, role: 'user', content: text })
    this.sendMessage(sessionId, userMessage)

    if (session.mode !== 'claude-code') return
try {
      const host = this.resolveHostFromSession(session.hostname)
      const harnessSession = await this.harness.resume(sessionId, { cwd: session.projectPath, host })
      await this.harness.streamInput(sessionId, text)
      const previousTurnCount = this.live.get(sessionId)?.turnCount ?? 0
      this.live.set(sessionId, newLiveStream(previousTurnCount))
      void this.consume(sessionId, harnessSession.events)
    } catch (err) {
      this.reportHarnessFailure(sessionId, 'sendUserMessage', err)
      throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.harness.interrupt(sessionId)
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
    void this.harness.interrupt(sessionId).catch(() => undefined)
    this.live.delete(sessionId)
    const session = this.store.closeSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    this.sendLifecycle({ type: 'session.closed', session })
    return session
  }

  deleteSession(sessionId: string): void {
    this.live.delete(sessionId)
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

  // ── Event stream consumption ─────────────────────────────────────────

  private async consume(sessionId: string, events: AsyncGenerator<HarnessEvent, void, void>): Promise<void> {
    for await (const event of events) {
      this.applyEvent(sessionId, event)
    }
  }

  private applyEvent(sessionId: string, event: HarnessEvent): void {
    const live = this.live.get(sessionId) ?? newLiveStream()
    this.live.set(sessionId, live)

    switch (event.type) {
      case 'text_delta': {
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
        return // structural event only; not rendered as its own transcript row

      case 'error': {
        this.flushBuffer(sessionId, live)
        const message = this.store.addMessage({
          sessionId,
          role: 'system',
          content: `Error: ${event.message}`,
          rawEvent: event
        })
        this.sendMessage(sessionId, message)
        return
      }

      case 'interrupted':
        this.flushBuffer(sessionId, live)
        return

      case 'result': {
        this.flushBuffer(sessionId, live)
        live.turnCount += 1
        if (live.turnCount >= AUTO_NAME_STARTING_FROM_TURN) {
          void this.maybeAutoName(sessionId).catch((err) =>
            logger.warn('auto-naming failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
          )
        }
        return
      }
    }
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
}

function deriveDefaultName(projectPath: string, prompt?: string): string {
  if (prompt && prompt.trim()) {
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ')
    return words.length < prompt.trim().length ? `${words}…` : words
  }
  const base = projectPath.split('/').filter(Boolean).pop() ?? projectPath
  return base
}
