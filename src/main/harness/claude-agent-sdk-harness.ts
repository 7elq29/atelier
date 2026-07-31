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
  Options as SdkOptions,
  Query as SdkQuery,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { HarnessDriver, HarnessEvent, HarnessSession, HarnessStartOptions, HarnessTodoItem, RemoteHost } from './types'
import { logger } from '../logger'

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

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

interface ActiveSession {
  query: SdkQuery
  queue: UserMessageQueue
  interruptRequested: boolean
  /** See `HarnessStartOptions.keepAlive`. */
  keepAlive: boolean
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
    return this.launch(prompt, opts, undefined)
  }

  async resume(sessionId: string, opts: Partial<HarnessStartOptions> = {}): Promise<HarnessSession> {
    const cwd = opts.cwd ?? process.cwd()
    return this.launch('', { ...opts, cwd }, sessionId)
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

  async streamInput(sessionId: string, message: string): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) return
    logger.info('harness.streamInput() called', { sessionId, textLength: message.length })
    active.queue.push(userMessage(message))
  }

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  private async launch(
    prompt: string,
    opts: HarnessStartOptions & { cwd: string },
    resumeSessionId: string | undefined,
  ): Promise<HarnessSession> {
    const sdk = await loadSdk()
    const sessionId = resumeSessionId ?? randomUUID()
    const queue = new UserMessageQueue()
    if (prompt) queue.push(userMessage(prompt))

    const options: SdkOptions = {
      cwd: opts.cwd,
      includePartialMessages: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : { sessionId }),
      ...(opts.model ? { model: opts.model } : {}),
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
    }

    const query = sdk.query({ prompt: queue, options })
    const active: ActiveSession = {
      query,
      queue,
      interruptRequested: false,
      keepAlive: opts.keepAlive ?? false,
      taskItems: new Map(),
      pendingTaskCalls: new Map(),
    }
    this.sessions.set(sessionId, active)

    return { sessionId, events: this.normalize(sessionId, query, active) }
  }

  private async *normalize(
    sessionId: string,
    query: SdkQuery,
    active: ActiveSession,
  ): AsyncGenerator<HarnessEvent, void, void> {
    try {
      for await (const message of query) {
        for (const event of toHarnessEvents(sessionId, message, active)) {
          yield event
        }
        if (message.type === 'result') {
          if (active.interruptRequested) {
            yield { type: 'interrupted', sessionId, timestamp: new Date().toISOString() }
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
      yield {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      }
      if (active.interruptRequested) {
        yield { type: 'interrupted', sessionId, timestamp: new Date().toISOString() }
      }
    } finally {
      active.queue.close()
      this.sessions.delete(sessionId)
    }
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
