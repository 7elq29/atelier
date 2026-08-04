/**
 * "Claude Code via Agent SDK" harness — the concrete implementation of
 * HarnessDriver for task 01-harness-abstraction.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` with
 * `includePartialMessages: true` for token-level streaming, and normalizes
 * its message stream into the HarnessEvent union.
 *
 * Auth: this file never reads or sets ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 * itself. Unless a caller explicitly passes `opts.env`, the SDK's `env`
 * option is left `undefined`, which per the SDK's own contract means "the
 * subprocess inherits process.env" — i.e. whatever ambient environment
 * launched the Gardenia process (same as how the `claude` CLI picks up
 * ANTHROPIC_BASE_URL on this machine) flows straight through.
 *
 * The SDK package ships ESM-only (`"type": "module"`), while Gardenia's
 * main process is bundled as CommonJS by electron-vite. A static
 * `import ... from '@anthropic-ai/claude-agent-sdk'` would be transpiled to
 * a `require()` and throw ERR_REQUIRE_ESM, so the module is loaded lazily
 * via dynamic `import()`, which Node allows from CJS regardless of target
 * module format.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  CanUseTool,
  Options as SdkOptions,
  PermissionResult,
  PermissionUpdate,
  Query as SdkQuery,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  HarnessAskQuestion,
  HarnessDriver,
  HarnessEvent,
  HarnessImageInput,
  HarnessSession,
  HarnessStartOptions,
  HarnessTodoItem,
  PromptResponse,
  RemoteHost,
} from './types'
import { logger } from '../logger'
import type { PermissionModeValue } from '../../shared/session-types'

/**
 * The app's real default model, applied whenever a caller doesn't specify
 * one explicitly — session creation, resume, and every turn that never
 * touched the composer's model picker (i.e. `opts.model` is `undefined`)
 * all get this instead of silently falling through to whatever the SDK's
 * own baked-in default happens to be. Applies uniformly, including in e2e
 * tests, which almost never interact with the model picker.
 */
const DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * Single-quotes a value for safe interpolation into a POSIX shell command
 * string (the remote side of the SSH command below runs through the
 * destination's login shell, so args built locally as an argv array must be
 * re-quoted here — unlike the local `spawn(cmd, args[])` path, which never
 * goes through a shell at all).
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Escapes a value for safe interpolation inside a *double-quoted* POSIX
 * shell string (as opposed to `shQuote`, which produces a single-quoted
 * string). Double quotes still allow the shell to expand `$`, `` ` ``, and
 * `\`, so those (plus the closing `"` itself) must be backslash-escaped.
 * Single quotes need no escaping inside double quotes.
 */
function shDoubleQuoteEscape(value: string): string {
  return value.replace(/[\\"$`]/g, '\\$&')
}

/**
 * Builds the `cd` target for the remote command.
 *
 * `shQuote` (single-quoting) is correct for arbitrary path bytes, but it
 * also disables the remote shell's own `~` expansion — `cd '~'` fails with
 * "no such file or directory: ~" because a single-quoted `~` is never
 * tilde-expanded by POSIX shells. Since Gardenia's remote-project-path
 * field is free text (see NewSessionModal's `remote-project-path` input),
 * a user typing the completely natural `~` or `~/projects/foo` would break
 * remote session creation entirely.
 *
 * Fix: special-case paths starting with `~` and build them with `$HOME`
 * (double-quoted, so the *remote* shell expands it) instead of relying on
 * the shell's own tilde-parsing. Everything else keeps using the existing
 * single-quoted `shQuote` path unchanged.
 */
function remoteCdTarget(cwd: string): string {
  if (cwd === '~') {
    return '"$HOME"'
  }
  if (cwd.startsWith('~/')) {
    const rest = cwd.slice(2)
    return `"$HOME/${shDoubleQuoteEscape(rest)}"`
  }
  return shQuote(cwd)
}

/**
 * Builds the SDK's `spawnClaudeCodeProcess` override for remote/devpod
 * sessions (02-session-lifecycle). Rather than inventing a bespoke remote
 * protocol, this reuses the SDK's own documented escape hatch
 * ("Use this to run Claude Code in VMs, containers, or remote environments"):
 * the SDK still builds the exact same `claude --input-format stream-json
 * --output-format stream-json ...` argv it would for a local run, but instead
 * of spawning it directly we spawn `ssh <host> -- <cd remoteCwd> && exec
 * claude <args>`, with the remote host's OWN `~/.claude/settings.json`
 * supplying auth (verified for real against qingqin-go.devpod-us-or: a
 * plain, unauthenticated-looking `ssh` connection resolves the same
 * `apiKeyHelper` mechanism as the local machine once `claude` is on PATH
 * there). `ssh`'s stdio is a transparent pipe in non-interactive mode, so the
 * SDK's stream-json protocol passes through unchanged, and Node's
 * `ChildProcess` already satisfies the `SpawnedProcess` shape (stdin/stdout
 * streams, kill/on/once/off, exitCode/signalCode) with no adapter needed.
 */
function makeRemoteSpawner(host: RemoteHost, remoteCwd: string): (opts: SpawnOptions) => SpawnedProcess {
  return (opts: SpawnOptions): SpawnedProcess => {
    const claudePath = host.remoteExecutablePath ?? 'claude'
    const remoteCommand = `cd ${remoteCdTarget(remoteCwd)} && exec ${shQuote(claudePath)} ${opts.args
      .map(shQuote)
      .join(' ')}`
    logger.info('spawning remote harness process over ssh', { sshHost: host.sshHost, remoteCwd })
    const child = spawn('ssh', ['-o', 'BatchMode=yes', host.sshHost, '--', remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.debug('remote harness stderr', { sshHost: host.sshHost, chunk: chunk.toString('utf-8').slice(0, 2000) })
    })
    // Node's ChildProcess already implements every member of SpawnedProcess.
    return child as unknown as SpawnedProcess
  }
}

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkModulePromise: Promise<SdkModule> | undefined
function loadSdk(): Promise<SdkModule> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
  }
  return sdkModulePromise
}

/**
 * Async push-queue that backs the SDK's "streaming input" mode
 * (`prompt: AsyncIterable<SDKUserMessage>`). Feeding the query this way
 * (rather than a plain string) is what makes `streamInput()` possible: the
 * generator never completes on its own, it waits for more messages until
 * explicitly `close()`d.
 */
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffered: SDKUserMessage[] = []
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: message, done: false })
    } else {
      this.buffered.push(message)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.buffered.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

/**
 * Builds an `SDKUserMessage`. Plain text (the common case, and everything
 * before 10g-enrichment-image-attachment) keeps `content` as a bare string.
 * When `image` is supplied, `content` becomes the real Anthropic Messages
 * API multi-block array instead — verified against the installed
 * `@anthropic-ai/sdk`'s `resources/messages/messages.d.ts` (which
 * `@anthropic-ai/claude-agent-sdk`'s own `SDKUserMessage.message: MessageParam`
 * re-exports): `MessageParam.content: string | Array<ContentBlockParam>`,
 * where a text block is `{ type: 'text', text }` (`TextBlockParam`) and an
 * image block is `{ type: 'image', source: { type: 'base64', media_type,
 * data } }` (`ImageBlockParam` / `Base64ImageSource`) — not guessed, and not
 * some other field naming (e.g. no `mime_type` or `content`-on-the-image).
 * The text block is omitted entirely when there's no accompanying text, so a
 * bare image attachment doesn't send an empty text block alongside it.
 */
function userMessage(text: string, image?: HarnessImageInput): SDKUserMessage {
  if (!image) {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    }
  }
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mimeType, data: image.data } },
      ],
    },
    parent_tool_use_id: null,
  }
}

/**
 * Generic async push-queue (05-interactive-prompts) — same pattern as
 * `UserMessageQueue` above, generalized so both the SDK-message pump AND a
 * concurrently-firing `canUseTool` callback can push onto ONE ordered
 * output stream. This is necessary because `canUseTool` control_requests
 * arrive over the SDK's transport independently of whichever `SDKMessage`
 * the consumer is currently awaiting (verified live: `canUseTool` fires
 * while `for await (const message of query)` is still resolving the
 * previous iteration) — a plain generator yielding only from that for-await
 * loop cannot also surface a `permission_request`/`ask_user_question`/
 * `plan_proposed` event the moment `canUseTool` is invoked.
 */
class PushQueue<T> implements AsyncIterable<T> {
  private buffered: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
    } else {
      this.buffered.push(value)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const next = this.buffered.shift()
        if (next !== undefined) return Promise.resolve({ value: next, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

interface ActiveSession {
  query: SdkQuery
  queue: UserMessageQueue
  interruptRequested: boolean
  /** See `HarnessStartOptions.keepAlive`. */
  keepAlive: boolean
  /** Merged output stream: SDK-message-derived events AND canUseTool-driven interactive-prompt events, in emission order — see `PushQueue`'s doc comment. */
  eventQueue: PushQueue<HarnessEvent>
  /**
   * Resolvers for prompts currently blocked in `canUseTool`, keyed by the
   * SDK's own `toolUseID` for that call (stable, unique, and already the
   * value plumbed through as `HarnessEvent.requestId`/`toolUseId` above).
   * Populated when a `permission_request`/`ask_user_question`/
   * `plan_proposed` event is emitted; resolved (and removed) by
   * `respondToPrompt`.
   */
  pendingPrompts: Map<string, (response: PromptResponse) => void>
  /**
   * Uber-internal task-tracking tool state. Verified for real against a live
   * turn (see 03-chat-surface-core's progress notes): this environment's
   * Claude Code build calls `TaskCreate`/`TaskUpdate` instead of the
   * "standard" `TodoWrite` tool 01-harness-abstraction assumed. Normalized
   * here into the same `todo_update` shape TodoWrite produces (a full
   * current snapshot per event) — keyed by the numeric task id the tool
   * itself assigns (parsed from `TaskCreate`'s tool_result text, e.g. "Task
   * #1 created successfully: ...", and matched against `TaskUpdate`'s
   * `taskId` input field, which uses that same id space).
   */
  taskItems: Map<string, HarnessTodoItem>
  /** toolUseId -> pending TaskCreate/TaskUpdate call, resolved once its tool_result (which carries the real numeric id for TaskCreate) arrives. */
  pendingTaskCalls: Map<string, { name: string; input: Record<string, unknown> }>
}

function extractOutputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('\n')
  }
  return ''
}

export class ClaudeAgentSdkHarness implements HarnessDriver {
  private readonly sessions = new Map<string, ActiveSession>()

  async start(prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    return this.launch(prompt, opts, { mode: 'fresh' })
  }

  async startWithId(sessionId: string, prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    return this.launch(prompt, opts, { mode: 'fresh-with-id', sessionId })
  }

  async resume(sessionId: string, opts: Partial<HarnessStartOptions> = {}): Promise<HarnessSession> {
    const cwd = opts.cwd ?? process.cwd()
    return this.launch('', { ...opts, cwd }, { mode: 'resume', sessionId })
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) return
    logger.info('harness.interrupt() called', { sessionId })
    active.interruptRequested = true
    await active.query.interrupt().catch(() => undefined)
    // Belt-and-suspenders teardown for 04-composer-core's now-persistent
    // sessions (see normalize()'s `continue` after `result`): `query.
    // interrupt()` only aborts a turn that's actively generating — verified
    // for real that calling it on an IDLE session (connected, waiting
    // between turns) does NOT make the query's for-await loop end on its
    // own (a probe left it hanging 60s+ with no further events). Closing
    // the input queue directly does end it cleanly either way (also
    // verified for real: closing while idle ends the loop in ~1s with no
    // extra event; closing while a turn is mid-flight doesn't cut that
    // turn's own result/interrupted event short, since it only affects the
    // NEXT `queue.next()` call, not the generation already in progress) —
    // so both closeSession's idle teardown and a mid-stream Stop-button
    // interrupt now terminate the session reliably.
    active.queue.close()
    logger.info('harness.interrupt(): input queue closed', { sessionId })
  }

  async streamInput(sessionId: string, message: string, image?: HarnessImageInput): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) return
    const sdkMessage = userMessage(message, image)
    // Logged as an explicit content-block-type list (not just "hasImage")
    // so an e2e test can grep the real, already-built SDK payload for proof
    // an 'image' block was actually sent — not merely that the UI showed a
    // thumbnail. `sdkMessage.message.content` is either the plain string
    // (no image) or the real multi-block array built by userMessage() above.
    const contentBlockTypes = Array.isArray(sdkMessage.message.content)
      ? sdkMessage.message.content.map((block) => block.type)
      : ['text']
    logger.info('harness.streamInput() called', {
      sessionId,
      textLength: message.length,
      hasImage: Boolean(image),
      imageMimeType: image?.mimeType,
      contentBlockTypes,
    })
    active.queue.push(sdkMessage)
  }

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  async respondToPrompt(sessionId: string, requestId: string, response: PromptResponse): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) {
      logger.warn('respondToPrompt: no active session', { sessionId, requestId, knownSessions: [...this.sessions.keys()] })
      return
    }
    const resolve = active.pendingPrompts.get(requestId)
    if (!resolve) {
      logger.warn('respondToPrompt: no pending prompt for requestId', { sessionId, requestId })
      return // unknown or already-resolved (e.g. a stale double-click)
    }
    active.pendingPrompts.delete(requestId)
    resolve(response)
    logger.info('respondToPrompt: resolved', { sessionId, requestId, kind: response.kind })
  }

  /**
   * 11-composer-mode-indicator: same `query.setPermissionMode()` call this
   * file already makes after an accepted `ExitPlanMode` (see `makeCanUseTool`
   * below), now exposed as a reusable driver method for the composer's
   * Shift+Tab cycle. A no-op when the session has no live connection right
   * now (e.g. cycled while idle/disconnected) — `SessionManager.cycleMode`
   * still records the new mode in its own tracked map either way, so it's
   * re-passed as `permissionMode` on this session's next `resume()`.
   */
  async setPermissionMode(sessionId: string, mode: PermissionModeValue): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) {
      logger.info('setPermissionMode: no live session, mode will apply on next resume', { sessionId, mode })
      return
    }
    await active.query.setPermissionMode(mode).catch((err) => {
      logger.warn('setPermissionMode: SDK call failed', { sessionId, mode, error: err instanceof Error ? err.message : String(err) })
    })
    logger.info('setPermissionMode: applied to live session', { sessionId, mode })
  }

  private async launch(
    prompt: string,
    opts: HarnessStartOptions & { cwd: string },
    spec: { mode: 'fresh' } | { mode: 'fresh-with-id'; sessionId: string } | { mode: 'resume'; sessionId: string },
  ): Promise<HarnessSession> {
    const sdk = await loadSdk()
    const sessionId = spec.mode === 'fresh' ? randomUUID() : spec.sessionId
    const queue = new UserMessageQueue()
    if (prompt) queue.push(userMessage(prompt))

    const active: ActiveSession = {
      // `query` is assigned right after `sdk.query(...)` below — TypeScript
      // can't see that from inside this object literal, so it's patched on
      // immediately afterward (still before anything can observe `active`).
      query: undefined as unknown as SdkQuery,
      queue,
      interruptRequested: false,
      keepAlive: opts.keepAlive ?? false,
      eventQueue: new PushQueue<HarnessEvent>(),
      pendingPrompts: new Map(),
      taskItems: new Map(),
      pendingTaskCalls: new Map(),
    }

    const options: SdkOptions = {
      cwd: opts.cwd,
      includePartialMessages: true,
      ...(spec.mode === 'resume' ? { resume: sessionId } : { sessionId }),
      model: opts.model ?? DEFAULT_MODEL,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      // Deliberately omitted when opts.env is undefined: per the SDK's
      // contract this makes the subprocess inherit process.env verbatim,
      // which is the auth-inheritance behavior this task must prove.
      ...(opts.env ? { env: opts.env } : {}),
      // Remote/devpod sessions: swap the local spawn for one that tunnels
      // over SSH. `cwd` above is still required by the SDK's types but is
      // meaningless to the (never-invoked) local spawn path in this case —
      // the real working directory is applied inside the ssh command itself.
      ...(opts.host ? { spawnClaudeCodeProcess: makeRemoteSpawner(opts.host, opts.cwd) } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      // 05-interactive-prompts: every permission prompt, AskUserQuestion,
      // and ExitPlanMode call is gated through this one callback — see the
      // doc comment on ActiveSession.pendingPrompts and makeCanUseTool below.
      canUseTool: makeCanUseTool(sessionId, active),
    }

    const query = sdk.query({ prompt: queue, options })
    active.query = query
    this.sessions.set(sessionId, active)

    // Runs eagerly (not lazily on first consumer pull) so canUseTool's
    // concurrent prompts are captured into eventQueue the instant they fire,
    // matching how SessionManager.consume() already drains `events`
    // immediately after creating/reconnecting a session.
    void this.pump(sessionId, query, active)

    // bug #56: seed the live slash-command registry from the SDK's own
    // control-protocol init response. This is deliberately NOT read off the
    // streamed `system`/`init` SDKMessage (see toHarnessEvents' 'init'
    // handling below) — that message only carries `slash_commands: string[]`
    // (bare names, no descriptions/argumentHint/aliases), whereas
    // `query.initializationResult()` resolves the full
    // `SDKControlInitializeResponse.commands: SlashCommand[]` (verified
    // against the installed `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`:
    // `SDKControlInitializeResponse` at ~line 3393, `commands:
    // coreTypes.SlashCommand[]` at ~line 3394; `SlashCommand` itself at
    // ~line 6495: `{ name, description, argumentHint, aliases? }`). Runs
    // fire-and-forget alongside `pump` above — whichever settles first, the
    // consumer (SessionManager) just sees an ordinary `commands_updated`
    // event land on the shared `eventQueue`.
    void query
      .initializationResult()
      .then((initResult) => {
        active.eventQueue.push({
          type: 'commands_updated',
          sessionId,
          timestamp: new Date().toISOString(),
          commands: initResult.commands.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            aliases: c.aliases,
          })),
        })
      })
      .catch((err) => {
        logger.warn('initializationResult() failed; live slash-command list unavailable for this session', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    return { sessionId, events: this.drain(active) }
  }

  /** Pulls SDKMessages off `query`, normalizes them, and pushes the results onto `active.eventQueue` — see PushQueue's doc comment for why this can't just be a plain yielding generator anymore. */
  private async pump(sessionId: string, query: SdkQuery, active: ActiveSession): Promise<void> {
    try {
      for await (const message of query) {
        for (const event of toHarnessEvents(sessionId, message, active)) {
          active.eventQueue.push(event)
        }
        if (message.type === 'result') {
          if (active.interruptRequested) {
            active.eventQueue.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
            return
          }
          if (!active.keepAlive) {
            // Default, one-shot behavior (unchanged from before
            // 04-composer-core): this session was never meant to accept a
            // follow-up (e.g. the auto-naming summarizer's own internal
            // `harness.start()` call) — nothing will ever push more input
            // or interrupt it, so ending right after `result` here is what
            // makes its own `for await (const event of session.events)`
            // complete at all. A real bug caught during this task: an
            // earlier version of this fix always fell through here
            // unconditionally, which hung every one-shot caller forever
            // (verified for real: `maybeAutoName()` never completed a
            // single run once this was in place, since nothing ever closes
            // or interrupts that particular session).
            return
          }
          // Genuinely-live multi-turn session (04-composer-core), opted
          // into via `HarnessStartOptions.keepAlive`: do NOT tear the query
          // down here. `query` is fed by `active.queue`, a still-open
          // `AsyncIterable` — verified for real against the SDK (a two-turn
          // probe: push message 1, wait for its `result`, then push message
          // 2 with no `resume()` in between) that the SAME `query()` call
          // keeps waiting on `queue.next()` and delivers a full second turn
          // (system/assistant/result) with no reconnect. Falling through
          // here (instead of returning) is what lets
          // `SessionManager.sendUserMessage` skip `resume()` for every
          // follow-up to a session that's still connected — including one
          // pushed mid-stream, before this turn's own `result` fires, which
          // the SDK simply folds into the turn already in progress.
          continue
        }
      }
    } catch (err) {
      // Bug fix (fix-session-resume-stale-sigterm-and-no-connect-indicator):
      // when `active.interruptRequested` is already true here, this throw is
      // an EXPECTED side effect of OUR OWN close()/interrupt() call (e.g.
      // closeSession() -> harness.interrupt() closes the SDK's internal
      // input queue, which can make query()'s async iterator reject instead
      // of completing cleanly) — not a genuine crash. Pushing an 'error'
      // event in that case used to get persisted by manager.ts's applyEvent
      // as a permanent system-role "Error: ..." chat message, which then
      // replayed on every future resume looking exactly like the reconnect
      // itself had just failed, even though the live reconnect never
      // actually failed. Only push 'error' (and therefore only ever surface
      // a system-role error message) for a termination NOT caused by our own
      // interrupt request — i.e. a genuine unexpected failure.
      if (!active.interruptRequested) {
        active.eventQueue.push({
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          message: err instanceof Error ? err.message : String(err),
        })
        // fix-remote-resume-conversation-lost-fallback: a GENUINE failure
        // (not our own interrupt) still leaves this `query`'s own internal
        // state around — verified for real that immediately retrying the
        // SAME session id (e.g. SessionManager's startWithId() fallback
        // right after a failed resume()) can otherwise collide with
        // "Session ID ... is already in use" for several seconds, even
        // though nothing in THIS process is still actually using it. An
        // explicit `interrupt()` call here (best-effort; the query is
        // already dead, so failures here are expected and ignored) signals
        // the SDK to release whatever it's still holding for this session,
        // the same call the deliberate close()/interrupt() path already
        // relies on below.
        void active.query.interrupt().catch(() => undefined)
      } else {
        active.eventQueue.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
      }
    } finally {
      active.queue.close()
      active.eventQueue.close()
      // Only remove the map entry if it's STILL this exact ActiveSession —
      // a `resume()` for the next turn can (and, per a real race verified
      // live, does) start and re-register `this.sessions.set(sessionId, ...)`
      // with a NEW ActiveSession before this (the PREVIOUS turn's) pump()
      // loop finishes draining its trailing messages. An unconditional
      // `delete(sessionId)` here would then remove the NEW turn's live
      // entry out from under it — `Map.delete` only looks at the key, not
      // which value is currently stored — silently orphaning any
      // `canUseTool` promise it has in flight (observed as
      // `respondToPrompt: no active session` even though the newer pump()
      // loop, and its canUseTool call, were still very much alive).
      if (this.sessions.get(sessionId) === active) {
        this.sessions.delete(sessionId)
      }
    }
  }

  private async *drain(active: ActiveSession): AsyncGenerator<HarnessEvent, void, void> {
    for await (const event of active.eventQueue) {
      yield event
    }
  }
}

/**
 * Builds the per-session `canUseTool` callback (05-interactive-prompts).
 * Routes all three interactive flows through the same mechanism: push a
 * HarnessEvent describing the pending decision, then block on a Promise
 * resolved by `ClaudeAgentSdkHarness.respondToPrompt` once the renderer's
 * IPC call arrives.
 *
 * Real API shapes below (verified live against @anthropic-ai/claude-agent-sdk
 * 0.3.212, and cross-checked against code.claude.com/docs/en/agent-sdk/
 * user-input + permissions — see progress.md):
 *  - `AskUserQuestion`'s answer format is `updatedInput: { questions,
 *    answers: { [questionText]: labelOrCsv } }` — NOT a per-question
 *    "answer" field (that silently produces "The user did not answer the
 *    questions.").
 *  - `ExitPlanMode`'s input is `{ plan: string, planFilePath?: string }`.
 *    Returning `{behavior:'allow'}` for it does NOT by itself exit plan
 *    mode — the session's `permissionMode` stays `'plan'` until
 *    `query.setPermissionMode('default')` is called explicitly, so a
 *    rejected/kept-planning decision must NOT call it (deny instead, with a
 *    message steering Claude back into planning).
 *  - Bash/Write/etc. permission prompts carry a `suggestions` array of ready
 *    `PermissionUpdate`s; echoing one back as `updatedPermissions` (with its
 *    `destination` overridden to `'session'`) is what makes "always allow
 *    this pattern" actually skip future prompts for matching calls — the
 *    SDK's own permission engine short-circuits `canUseTool` entirely for
 *    the rest of the session, it isn't something Gardenia re-implements.
 */
function makeCanUseTool(sessionId: string, active: ActiveSession): CanUseTool {
  function waitForResponse(requestId: string, emit: () => HarnessEvent): Promise<PromptResponse> {
    return new Promise((resolve) => {
      active.pendingPrompts.set(requestId, resolve)
      const event = emit()
      logger.info('canUseTool: awaiting prompt response', { sessionId, requestId, eventType: event.type })
      active.eventQueue.push(event)
    })
  }

  return async (toolName, input, opts): Promise<PermissionResult> => {
    const timestamp = new Date().toISOString()
    const requestId = opts.toolUseID

    if (toolName === 'AskUserQuestion') {
      const questions = ((input as { questions?: unknown }).questions ?? []) as HarnessAskQuestion[]
      const response = await waitForResponse(requestId, () => ({
        type: 'ask_user_question',
        sessionId,
        timestamp,
        requestId,
        toolUseId: requestId,
        questions,
      }))
      if (response.kind !== 'ask_user_question') {
        return { behavior: 'deny', message: 'Internal error: mismatched prompt response' }
      }
      const updatedInput: Record<string, unknown> = { questions }
      if (response.freeText) {
        updatedInput.response = response.freeText
      } else {
        updatedInput.answers = response.answers
      }
      return { behavior: 'allow', updatedInput }
    }

    if (toolName === 'ExitPlanMode') {
      const planInput = input as { plan?: string; planFilePath?: string }
      const response = await waitForResponse(requestId, () => ({
        type: 'plan_proposed',
        sessionId,
        timestamp,
        requestId,
        toolUseId: requestId,
        plan: planInput.plan ?? '',
        planFilePath: planInput.planFilePath,
      }))
      if (response.kind !== 'plan') {
        return { behavior: 'deny', message: 'Internal error: mismatched prompt response' }
      }
      if (response.decision === 'accept') {
        // Approving the ExitPlanMode tool call alone does not flip the
        // session out of plan mode (verified live) — without this, every
        // subsequent Write/Edit/Bash-write call keeps getting routed back
        // here as if still planning.
        await active.query.setPermissionMode('default').catch(() => undefined)
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
      }
      const message =
        response.feedback ||
        (response.decision === 'keep_planning'
          ? 'The user wants to keep exploring/refining the plan — do not exit plan mode yet.'
          : 'The user rejected this plan. Ask what they would like changed before proposing another.')
      return { behavior: 'deny', message }
    }

    // Generic tool-use permission prompt (Bash, Write, Edit, ...).
    const addRulesSuggestion = opts.suggestions?.find(
      (s): s is Extract<PermissionUpdate, { type: 'addRules' }> => s.type === 'addRules',
    )
    const suggestedPattern = addRulesSuggestion?.rules[0]?.ruleContent
    const response = await waitForResponse(requestId, () => ({
      type: 'permission_request',
      sessionId,
      timestamp,
      requestId,
      toolUseId: requestId,
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      suggestedPattern,
    }))
    if (response.kind !== 'permission') {
      return { behavior: 'deny', message: 'Internal error: mismatched prompt response' }
    }
    if (response.decision === 'deny') {
      return { behavior: 'deny', message: 'User denied this action' }
    }
    if (response.alwaysAllow && addRulesSuggestion) {
      return {
        behavior: 'allow',
        updatedInput: input as Record<string, unknown>,
        updatedPermissions: [{ ...addRulesSuggestion, destination: 'session' }],
      }
    }
    return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
  }
}

function toHarnessEvents(sessionId: string, message: SDKMessage, active: ActiveSession): HarnessEvent[] {
  const timestamp = new Date().toISOString()

  if (message.type === 'system' && message.subtype === 'init') {
    return [
      {
        type: 'session_started',
        sessionId,
        timestamp,
        model: message.model,
        cwd: message.cwd,
        apiKeySource: message.apiKeySource,
      },
    ]
  }

  if (message.type === 'system' && message.subtype === 'commands_changed') {
    // bug #56: fire-and-forget mid-session push of the FULL slash-command
    // list (verified against `SDKCommandsChangedMessage`, sdk.d.ts ~line
    // 2880: "Clients should REPLACE their cached command list with this
    // payload") — e.g. new skills discovered as the agent explores a
    // subdirectory. Same shape as the one-time `initializationResult()`
    // seed above, so SessionManager/renderer handle both identically.
    return [
      {
        type: 'commands_updated',
        sessionId,
        timestamp,
        commands: message.commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
      },
    ]
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    return [
      {
        type: 'compaction',
        sessionId,
        timestamp,
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        postTokens: message.compact_metadata.post_tokens,
      },
    ]
  }

  if (message.type === 'stream_event') {
    const event = message.event
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      return [{ type: 'text_delta', sessionId, timestamp, text: event.delta.text }]
    }
    return []
  }

  if (message.type === 'assistant') {
    const events: HarnessEvent[] = []
    const content = message.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          events.push({
            type: 'tool_call_start',
            sessionId,
            timestamp,
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            parentToolUseId: message.parent_tool_use_id,
          })
          if (block.name === 'TodoWrite') {
            const todos = (block.input as { todos?: unknown } | undefined)?.todos
            if (Array.isArray(todos)) {
              events.push({ type: 'todo_update', sessionId, timestamp, todos: todos as never })
            }
          }
          if (block.name === 'TaskCreate' || block.name === 'TaskUpdate') {
            active.pendingTaskCalls.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
          }
        }
      }
    }
    return events
  }

  if (message.type === 'user') {
    const events: HarnessEvent[] = []
    const content = message.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_call_end',
            sessionId,
            timestamp,
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            output: block.content,
            parentToolUseId: message.parent_tool_use_id,
          })

          const pendingTask = active.pendingTaskCalls.get(block.tool_use_id)
          if (pendingTask) {
            active.pendingTaskCalls.delete(block.tool_use_id)
            const outputText = extractOutputText(block.content)
            if (pendingTask.name === 'TaskCreate') {
              const idMatch = outputText.match(/#(\d+)/)
              const taskId = idMatch?.[1] ?? block.tool_use_id
              const subject =
                (pendingTask.input.subject as string | undefined) ??
                (pendingTask.input.description as string | undefined) ??
                'Task'
              active.taskItems.set(taskId, { content: subject, status: 'pending' })
            } else {
              // TaskUpdate: the taskId is already given explicitly in the input (same id space TaskCreate's output assigns).
              const taskId = String(pendingTask.input.taskId ?? block.tool_use_id)
              const existing = active.taskItems.get(taskId)
              const status = (pendingTask.input.status as string | undefined) ?? existing?.status ?? 'pending'
              active.taskItems.set(taskId, { content: existing?.content ?? 'Task', status })
            }
            events.push({ type: 'todo_update', sessionId, timestamp, todos: [...active.taskItems.values()] })
          }
        }
      }
    }
    return events
  }

  if (message.type === 'result') {
    return [
      {
        type: 'result',
        sessionId,
        timestamp,
        isError: message.is_error,
        subtype: message.subtype,
        result: message.subtype === 'success' ? message.result : undefined,
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
        totalCostUsd: message.total_cost_usd,
        usage: message.usage,
      },
    ]
  }

  return []
}
