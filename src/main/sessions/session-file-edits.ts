import { isAbsolute, relative, resolve } from 'node:path'
import {
  filePathsForFileEditTool,
  isSessionFileEditTool,
  lineStatsForFileEditTool,
  type SessionFileEdit
} from '../../shared/session-file-edits'
import { parseStructuredContent, type ToolCallContent } from '../../shared/chat-content'
import type { SessionStore } from './store'

export function normalizeToRepoRelativePath(filePath: string, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot)
  const normalized = filePath.replace(/\\/g, '/')

  if (!isAbsolute(normalized)) {
    const rel = normalized.replace(/^\.\//, '')
    const abs = resolve(root, rel)
    const fromRoot = relative(root, abs)
    if (fromRoot.startsWith('..') || fromRoot === '') return null
    return fromRoot.split(/\\/g).join('/')
  }

  const abs = resolve(normalized)
  if (abs === root || abs.startsWith(root + '/')) {
    return relative(root, abs).split(/\\/g).join('/')
  }

  // Some tool calls use a leading slash for repo-relative paths (e.g. `/src/foo.js`).
  const stripLead = normalized.replace(/^\//, '')
  if (stripLead && !stripLead.includes('..')) {
    const underRoot = resolve(root, stripLead)
    if (underRoot === root || underRoot.startsWith(root + '/')) {
      return relative(root, underRoot).split(/\\/g).join('/')
    }
  }

  return null
}

export function recordFileEditFromToolCall(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  toolName: string,
  input: unknown
): SessionFileEdit[] {
  if (!isSessionFileEditTool(toolName)) return store.listSessionFileEdits(sessionId)
  const stats = lineStatsForFileEditTool(toolName, input)
  if (!stats) return store.listSessionFileEdits(sessionId)
  const now = new Date().toISOString()
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = normalizeToRepoRelativePath(rawPath, workspaceRoot)
    if (!path) continue
    store.accumulateSessionFileEdit(sessionId, path, stats.additions, stats.deletions, now)
  }
  return store.listSessionFileEdits(sessionId)
}

export function rebuildSessionFileEditsFromMessages(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string
): void {
  store.clearSessionFileEdits(sessionId)
  const messages = store.listMessages(sessionId)
  const rollup = new Map<string, { additions: number; deletions: number }>()
  const now = new Date().toISOString()

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'tool_call') continue
    const content = structured as ToolCallContent
    if (content.status !== 'completed') continue
    if (!isSessionFileEditTool(content.name)) continue
    const stats = lineStatsForFileEditTool(content.name, content.input)
    if (!stats) continue
    for (const rawPath of filePathsForFileEditTool(content.name, content.input)) {
      const path = normalizeToRepoRelativePath(rawPath, workspaceRoot)
      if (!path) continue
      const prev = rollup.get(path) ?? { additions: 0, deletions: 0 }
      prev.additions += stats.additions
      prev.deletions += stats.deletions
      rollup.set(path, prev)
    }
  }

  for (const [path, stats] of rollup) {
    store.accumulateSessionFileEdit(sessionId, path, stats.additions, stats.deletions, now)
  }
}
