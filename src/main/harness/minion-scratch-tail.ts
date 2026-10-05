/**
 * Append-aware chat.jsonl parser → HarnessEvents (tool cards + task rail + text).
 */

import type { HarnessEvent } from './types'

export interface ScratchTailWatermark {
  /** Length of chat.jsonl content already consumed (JS string length). */
  contentLength: number
  /** Last sizeBytes from listScratchFiles (skip fetch when unchanged). */
  sizeBytes: number
  mtime: number
  /** True after the first successful chat.jsonl read for this task. */
  seeded: boolean
  /** True while list/get succeed and chat.jsonl exists — prefer scratch over orchestrator text. */
  healthy: boolean
}

export function emptyScratchWatermark(): ScratchTailWatermark {
  return { contentLength: 0, sizeBytes: -1, mtime: 0, seeded: false, healthy: false }
}

export interface ScratchProgressChrome {
  title: string
  detail: string
}

function tsIso(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Scratch timestamps are sometimes ms, sometimes weird large values — clamp.
    const ms = raw > 1e14 ? Math.floor(raw / 1000) : raw
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
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
  if (typeof o.skill === 'string') return o.skill
  return name
}

/** Map one NDJSON object to zero or more harness events + optional chrome hint. */
export function mapScratchLine(
  sessionId: string,
  obj: Record<string, unknown>,
  lineIndex: number
): { events: HarnessEvent[]; chrome?: ScratchProgressChrome; text?: string } {
  const type = String(obj.type ?? '')
  const timestamp = tsIso(obj.timestamp)
  const events: HarnessEvent[] = []
  let chrome: ScratchProgressChrome | undefined
  let text: string | undefined

  if (type === 'tool_start') {
    const ts = (obj.tool_start && typeof obj.tool_start === 'object'
      ? obj.tool_start
      : obj) as Record<string, unknown>
    const toolUseId = String(ts.tool_use_id ?? ts.toolUseId ?? `minion-tool:${lineIndex}`)
    const name = String(ts.tool_name ?? ts.toolName ?? 'Tool')
    const input = parseInputJson(ts.input_json ?? ts.inputJson ?? ts.input)
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
    return { events, chrome }
  }

  if (type === 'tool_result') {
    const tr = (obj.tool_result && typeof obj.tool_result === 'object'
      ? obj.tool_result
      : obj) as Record<string, unknown>
    const toolUseId = String(tr.tool_use_id ?? tr.toolUseId ?? `minion-tool:${lineIndex}`)
    const isError = Boolean(tr.is_error ?? tr.isError)
    events.push({
      type: 'tool_call_end',
      sessionId,
      timestamp,
      toolUseId,
      isError,
      output: tr.content ?? tr.output ?? null,
      parentToolUseId: null
    })
    return { events }
  }

  if (type === 'task_started') {
    const t = (obj.task_started && typeof obj.task_started === 'object'
      ? obj.task_started
      : obj) as Record<string, unknown>
    const taskId = String(t.bg_task_id ?? t.task_id ?? t.taskId ?? `minion-task:${lineIndex}`)
    const description = String(t.description ?? 'Task').trim() || 'Task'
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
    return { events, chrome }
  }

  if (type === 'task_progress') {
    const t = (obj.task_progress && typeof obj.task_progress === 'object'
      ? obj.task_progress
      : obj) as Record<string, unknown>
    const taskId = String(t.bg_task_id ?? t.task_id ?? t.taskId ?? `minion-task:${lineIndex}`)
    const description = String(t.description ?? '').trim()
    const lastToolName = typeof t.last_tool_name === 'string' ? t.last_tool_name : undefined
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
    return { events, chrome }
  }

  if (type === 'task_completed') {
    const t = (obj.task_completed && typeof obj.task_completed === 'object'
      ? obj.task_completed
      : obj) as Record<string, unknown>
    const taskId = String(t.bg_task_id ?? t.task_id ?? t.taskId ?? `minion-task:${lineIndex}`)
    const statusRaw = String(t.status ?? 'completed').toLowerCase()
    const summary = String(t.summary ?? t.description ?? '').trim()
    const failed = /fail|error|kill|stop/.test(statusRaw)
    events.push({
      type: 'task_notification',
      sessionId,
      timestamp,
      taskId,
      status: failed ? 'failed' : 'completed',
      summary: summary || (failed ? 'Failed' : 'Completed')
    })
    return { events }
  }

  if (type === 'text_delta') {
    const td = (obj.text_delta && typeof obj.text_delta === 'object'
      ? obj.text_delta
      : obj) as Record<string, unknown>
    const chunk = String(td.text ?? td.content ?? '').trim()
    if (!chunk) return { events }
    text = chunk
    events.push({ type: 'text_delta', sessionId, timestamp, text: chunk })
    events.push({
      type: 'result',
      sessionId,
      timestamp,
      isError: false,
      subtype: 'minion_progress',
      numTurns: 1,
      durationMs: 0,
      totalCostUsd: 0,
      usage: null
    })
    return { events, text }
  }

  if (type === 'workflow_progress') {
    const wp = (obj.workflow_progress && typeof obj.workflow_progress === 'object'
      ? obj.workflow_progress
      : obj) as Record<string, unknown>
    const stages = Array.isArray(wp.stages) ? (wp.stages as Array<Record<string, unknown>>) : []
    const active = stages.find((s) => String(s.status ?? '').toLowerCase() === 'active')
    const name = active ? String(active.name ?? 'Working…') : 'Working…'
    chrome = { title: name, detail: 'Workflow progress' }
    return { events, chrome }
  }

  return { events }
}

/**
 * Parse newly appended chat.jsonl content after `watermark.contentLength`.
 * Returns events to push and an updated watermark (contentLength advanced).
 */
export function consumeScratchAppend(
  sessionId: string,
  fullContent: string,
  watermark: ScratchTailWatermark
): {
  events: HarnessEvent[]
  chrome?: ScratchProgressChrome
  texts: string[]
  next: ScratchTailWatermark
} {
  let start = watermark.contentLength
  if (start > fullContent.length) start = 0
  const chunk = fullContent.slice(start)
  // Only consume complete lines; leave a trailing partial line for next fetch.
  const lastNl = chunk.lastIndexOf('\n')
  const complete = lastNl >= 0 ? chunk.slice(0, lastNl + 1) : (fullContent.endsWith('\n') ? chunk : '')
  // If the whole file has no trailing newline yet and we have never seeded, still
  // try to parse the single incomplete buffer once size is stable — but prefer
  // waiting for newline. When chunk equals full file and seeded is false and
  // file ends without newline, parse all lines split by \n anyway.
  const toParse =
    complete ||
    (!watermark.seeded && chunk.trim() ? chunk : '')

  const events: HarnessEvent[] = []
  const texts: string[] = []
  let chrome: ScratchProgressChrome | undefined
  let lineBase = fullContent.slice(0, start).split('\n').length - (start > 0 && !fullContent.slice(0, start).endsWith('\n') ? 0 : 1)
  if (lineBase < 0) lineBase = 0

  if (toParse) {
    const lines = toParse.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const mapped = mapScratchLine(sessionId, obj, lineBase + i)
      events.push(...mapped.events)
      if (mapped.chrome) chrome = mapped.chrome
      if (mapped.text) texts.push(mapped.text)
    }
  }

  const consumed = toParse === complete ? start + complete.length : fullContent.length
  const next: ScratchTailWatermark = {
    ...watermark,
    contentLength: Math.max(watermark.contentLength, consumed),
    seeded: true,
    healthy: true
  }
  return { events, chrome, texts, next }
}
