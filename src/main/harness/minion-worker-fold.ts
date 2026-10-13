/**
 * Seq-keyed Minion worker / storage event fold → Atelier harness events.
 *
 * Clone of Minion Web / uTerm: apply events in order, never apply the same
 * seq twice. Source may be the live worker WebSocket or durable chat.jsonl
 * from getFileContents (works for sleeping tips with known devpod name/region).
 */

import type { HarnessEvent } from './types'
import type { MinionWorkerEvent } from './minion-worker-socket'

export type FoldPhase = 'storage' | 'replay' | 'live'

export interface FoldChrome {
  title: string
  detail: string
}

export interface FoldApplyResult {
  events: HarnessEvent[]
  chrome?: FoldChrome
  /** True when an assistant text_delta was emitted (clears steer wait). */
  sawAssistantText: boolean
}

function tsIso(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e14 ? Math.floor(raw / 1000) : raw
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parseInputJson(raw: unknown): unknown {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return { value: raw }
  const s = raw.trim()
  if (!s) return {}
  try {
    return JSON.parse(s) as unknown
  } catch {
    return { raw: s }
  }
}

function toolPreview(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const o = input as Record<string, unknown>
  if (name === 'Bash' && typeof o.command === 'string') {
    const cmd = o.command.replace(/\s+/g, ' ').trim()
    return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd
  }
  if (typeof o.description === 'string' && o.description.trim()) return o.description.trim()
  if (typeof o.file_path === 'string') return o.file_path
  if (typeof o.path === 'string') return o.path
  return name
}

/** Decode one NDJSON chat.jsonl / worker raw object into a MinionWorkerEvent. */
export function decodeWorkerRaw(raw: Record<string, unknown>): MinionWorkerEvent | null {
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (!type) return null
  const seqRaw = raw.seq
  const seq =
    typeof seqRaw === 'number' && Number.isFinite(seqRaw)
      ? seqRaw
      : typeof seqRaw === 'string' && /^\d+$/.test(seqRaw)
        ? Number(seqRaw)
        : undefined
  // Some early lines omit seq — synthesize from timestamp so we can still fold.
  const syntheticSeq =
    seq ??
    (typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : undefined)
  if (syntheticSeq === undefined) return null

  const statusChange = asRecord(raw.status_change)
  const textDelta = asRecord(raw.text_delta)
  const userMessage = asRecord(raw.user_message)
  const elicitation = asRecord(raw.elicitation_request) ?? asRecord(raw.elicitation)
  const elicitationResponse = asRecord(raw.elicitation_response)
  const toolStart = asRecord(raw.tool_start)
  const toolResult = asRecord(raw.tool_result)

  return {
    type,
    seq: syntheticSeq,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    status: statusChange
      ? typeof statusChange.status === 'number'
        ? statusChange.status
        : undefined
      : undefined,
    call_id:
      (typeof elicitation?.call_id === 'string' && elicitation.call_id) ||
      (typeof elicitationResponse?.call_id === 'string' && elicitationResponse.call_id) ||
      undefined,
    text: typeof textDelta?.text === 'string' ? textDelta.text : undefined,
    role: typeof textDelta?.role === 'string' ? textDelta.role : undefined,
    message: typeof userMessage?.message === 'string' ? userMessage.message : undefined,
    questions: elicitation?.questions,
    answers:
      elicitationResponse?.answers && typeof elicitationResponse.answers === 'object'
        ? (elicitationResponse.answers as Record<string, string | readonly string[]>)
        : undefined,
    raw: {
      ...raw,
      ...(toolStart ? { tool_start: toolStart } : {}),
      ...(toolResult ? { tool_result: toolResult } : {})
    }
  }
}

/** Parse durable chat.jsonl into worker events (sorted by seq). */
export function parseChatJsonl(content: string): MinionWorkerEvent[] {
  const out: MinionWorkerEvent[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>
      const ev = decodeWorkerRaw(raw)
      if (ev) out.push(ev)
    } catch {
      /* skip bad line */
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/**
 * Fold state for one Atelier Minion session. Owns lastAppliedSeq and maps
 * worker/storage events → harness events.
 */
export class MinionWorkerFold {
  private lastAppliedSeq: number | undefined
  private openToolIds = new Set<string>()

  get lastSeq(): number | undefined {
    return this.lastAppliedSeq
  }

  /** Restore cursor after soft-stop / resume (reconnect with since=). */
  restoreLastSeq(seq: number | undefined): void {
    this.lastAppliedSeq = seq
  }

  /** Clear cursor and open tools — used for resetOnConnect after storage fold. */
  reset(): void {
    this.lastAppliedSeq = undefined
    this.openToolIds.clear()
  }

  apply(
    sessionId: string,
    events: MinionWorkerEvent[],
    phase: FoldPhase
  ): FoldApplyResult {
    const out: HarnessEvent[] = []
    let chrome: FoldChrome | undefined
    let sawAssistantText = false
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    for (const ev of sorted) {
      if (this.lastAppliedSeq !== undefined && ev.seq <= this.lastAppliedSeq) continue
      this.lastAppliedSeq = ev.seq
      const timestamp = tsIso(ev.timestamp)
      const mapped = this.mapOne(sessionId, ev, timestamp, phase)
      out.push(...mapped.events)
      if (mapped.chrome) chrome = mapped.chrome
      if (mapped.sawAssistantText) sawAssistantText = true
    }

    return { events: out, chrome, sawAssistantText }
  }

  private mapOne(
    sessionId: string,
    ev: MinionWorkerEvent,
    timestamp: string,
    phase: FoldPhase
  ): FoldApplyResult {
    const events: HarnessEvent[] = []
    let chrome: FoldChrome | undefined
    let sawAssistantText = false

    if (ev.type === 'status_change') {
      // Working bit handled by harness socket callbacks — not transcript.
      return { events, sawAssistantText }
    }

    if (ev.type === 'session_end') {
      return { events, sawAssistantText }
    }

    if (ev.type === 'user_message' && ev.message?.trim()) {
      // History / remote user turns — SessionManager maps this to a user row.
      // Skip live echoes of Atelier steers (harness sets skipLiveUserEcho).
      if (phase === 'live') {
        return { events, sawAssistantText }
      }
      events.push({
        type: 'transcript_user_message',
        sessionId,
        timestamp,
        text: ev.message.trim()
      })
      return { events, sawAssistantText }
    }

    if (ev.type === 'text_delta' && ev.text) {
      const role = (ev.role || 'assistant').toLowerCase()
      if (role && role !== 'assistant') {
        return { events, sawAssistantText }
      }
      const text = phase === 'live' ? ev.text : ev.text.trim()
      if (!text) return { events, sawAssistantText }
      events.push({ type: 'text_delta', sessionId, timestamp, text })
      // Live tokens stream into SessionManager's buffer; flush on leave-RUNNING.
      // Storage/replay rows are complete messages — close them immediately.
      if (phase !== 'live') {
        events.push({
          type: 'result',
          sessionId,
          timestamp,
          isError: false,
          subtype: 'end_turn',
          numTurns: 1,
          durationMs: 0,
          totalCostUsd: 0,
          usage: null
        })
      }
      sawAssistantText = true
      return { events, chrome, sawAssistantText }
    }

    if (ev.type === 'tool_start') {
      const ts = asRecord(ev.raw.tool_start) ?? ev.raw
      const toolUseId = String(ts.tool_use_id ?? ts.toolUseId ?? `minion-tool:${ev.seq}`)
      const name = String(ts.tool_name ?? ts.toolName ?? 'Tool')
      const input = parseInputJson(ts.input_json ?? ts.inputJson ?? ts.input)
      this.openToolIds.add(toolUseId)
      events.push({
        type: 'tool_call_start',
        sessionId,
        timestamp,
        toolUseId,
        name,
        input,
        parentToolUseId: null
      })
      chrome = { title: `Running ${name}`, detail: toolPreview(name, input) }
      return { events, chrome, sawAssistantText }
    }

    if (ev.type === 'tool_result') {
      const tr = asRecord(ev.raw.tool_result) ?? ev.raw
      const toolUseId = String(tr.tool_use_id ?? tr.toolUseId ?? `minion-tool:${ev.seq}`)
      const isError = Boolean(tr.is_error ?? tr.isError)
      this.openToolIds.delete(toolUseId)
      events.push({
        type: 'tool_call_end',
        sessionId,
        timestamp,
        toolUseId,
        isError,
        output: tr.content ?? tr.output ?? null,
        parentToolUseId: null
      })
      return { events, sawAssistantText }
    }

    if (ev.type === 'elicitation_request' && ev.call_id && Array.isArray(ev.questions)) {
      // Harness maps questions via existing elicitation helper — emit ask_user_question
      // only when questions are already in AskUserQuestion shape; otherwise harness
      // parseMinionElicitation path handles string payloads.
      return { events, sawAssistantText }
    }

    if (ev.type === 'workflow_progress') {
      const wp = asRecord(ev.raw.workflow_progress) ?? ev.raw
      const stages = Array.isArray(wp.stages) ? (wp.stages as Array<Record<string, unknown>>) : []
      const active = stages.find((s) => String(s.status ?? '').toLowerCase() === 'active')
      const name = active ? String(active.name ?? 'Working…') : 'Working…'
      chrome = { title: name, detail: 'Workflow progress' }
      return { events, chrome, sawAssistantText }
    }

    if (ev.type === 'task_started' || ev.type === 'task_progress' || ev.type === 'task_completed') {
      // Background task rail — reuse scratch mapper shapes via raw.
      const nested = asRecord(ev.raw[ev.type]) ?? ev.raw
      if (ev.type === 'task_started') {
        const taskId = String(nested.bg_task_id ?? nested.task_id ?? nested.taskId ?? `minion-task:${ev.seq}`)
        const description = String(nested.description ?? 'Task').trim() || 'Task'
        events.push({
          type: 'task_started',
          sessionId,
          timestamp,
          taskId,
          description,
          taskType: 'local_agent',
          skipTranscript: true
        })
        events.push({
          type: 'task_updated',
          sessionId,
          timestamp,
          taskId,
          patch: { status: 'running', description }
        })
        chrome = { title: description, detail: 'In progress' }
      } else if (ev.type === 'task_progress') {
        const taskId = String(nested.bg_task_id ?? nested.task_id ?? nested.taskId ?? `minion-task:${ev.seq}`)
        const description = String(nested.description ?? '').trim()
        const lastToolName =
          typeof nested.last_tool_name === 'string' ? nested.last_tool_name : undefined
        events.push({
          type: 'task_progress',
          sessionId,
          timestamp,
          taskId,
          description: description || 'Working…',
          lastToolName
        })
        chrome = {
          title: description || 'Working…',
          detail: lastToolName ? `Last tool: ${lastToolName}` : 'In progress'
        }
      } else {
        const taskId = String(nested.bg_task_id ?? nested.task_id ?? nested.taskId ?? `minion-task:${ev.seq}`)
        const statusRaw = String(nested.status ?? 'completed').toLowerCase()
        const summary = String(nested.summary ?? nested.description ?? '').trim()
        const failed = /fail|error|kill|stop/.test(statusRaw)
        events.push({
          type: 'task_notification',
          sessionId,
          timestamp,
          taskId,
          status: failed ? 'failed' : 'completed',
          summary: summary || (failed ? 'Failed' : 'Completed')
        })
      }
      return { events, chrome, sawAssistantText }
    }

    return { events, sawAssistantText }
  }
}
