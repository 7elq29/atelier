import {
  getPathWorkingTreeNumstat,
  latestReflogSubject,
  listCommitChangedPaths,
  listCommitsInRange,
  resolveHead
} from '../panels/git'
import {
  filePathsForFileEditTool,
  isSessionFileEditTool,
  type SessionFileEdit
} from '../../shared/session-file-edits'
import type { SessionChangesCap, SessionChangesCapItem } from '../../shared/session-changes-cap'
import { parseStructuredContent, type ToolCallContent } from '../../shared/chat-content'
import type { SessionStore } from './store'
import { normalizeToRepoRelativePath } from './session-file-edits'

function isPullLikeReflog(subject: string): boolean {
  const s = subject.toLowerCase()
  if (s.includes('pull')) return true
  if (s.includes('fetch') && (s.includes('merge') || s.includes('fast-forward'))) return true
  return false
}

export function registerTouchedPathFromToolCall(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  toolName: string,
  input: unknown
): void {
  if (!isSessionFileEditTool(toolName)) return
  const now = new Date().toISOString()
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = normalizeToRepoRelativePath(rawPath, workspaceRoot)
    if (!path) continue
    store.registerSessionTouchedPath(sessionId, path, now)
  }
}

export async function syncSessionGitCursor(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null
): Promise<void> {
  const head = await resolveHead(workspacePath, hostname)
  if (!head) return
  const cursor = store.getSessionGitCursor(sessionId)
  if (!cursor?.baselineHead) {
    store.upsertSessionGitCursor(sessionId, head, head)
    return
  }
  if (!cursor.lastHead) {
    store.upsertSessionGitCursor(sessionId, head, cursor.baselineHead)
  }
}

export async function processHeadAdvanceIfNeeded(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null
): Promise<void> {
  const newHead = await resolveHead(workspacePath, hostname)
  if (!newHead) return

  let cursor = store.getSessionGitCursor(sessionId)
  if (!cursor) {
    store.upsertSessionGitCursor(sessionId, newHead, newHead)
    return
  }

  const oldHead = cursor.lastHead ?? cursor.baselineHead
  if (!oldHead || oldHead === newHead) {
    if (cursor.lastHead !== newHead) store.upsertSessionGitCursor(sessionId, newHead, cursor.baselineHead ?? newHead)
    return
  }

  const reflog = await latestReflogSubject(workspacePath, hostname)
  if (!isPullLikeReflog(reflog)) {
    const touched = new Set(store.listSessionTouchedPaths(sessionId).map((r) => r.path))
    if (touched.size > 0) {
      const commits = await listCommitsInRange(workspacePath, oldHead, newHead, hostname)
      let order = Date.now()
      for (const c of commits) {
        const files = await listCommitChangedPaths(workspacePath, c.hash, hostname)
        const hits = files.some((f) => touched.has(f))
        if (!hits) continue
        store.insertSessionCapCommit(sessionId, c.hash, c.subject, c.committedAt, order)
        order += 1
      }
    }
  }

  store.upsertSessionGitCursor(sessionId, newHead, cursor.baselineHead ?? oldHead)
}

export async function buildSessionChangesCap(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null
): Promise<SessionChangesCap> {
  const paths = store.listSessionTouchedPaths(sessionId)
  const now = new Date().toISOString()
  const fileItems: SessionChangesCapItem[] = []

  for (const row of paths) {
    const stats = await getPathWorkingTreeNumstat(workspacePath, row.path, hostname)
    if (!stats) continue
    const sortAt = now
    store.updateSessionTouchedPathPendingAt(sessionId, row.path, sortAt)
    fileItems.push({
      kind: 'file',
      path: row.path,
      additions: stats.additions,
      deletions: stats.deletions,
      sortAt
    })
  }

  const commitRows = store.listSessionCapCommits(sessionId)
  const commitItems: SessionChangesCapItem[] = commitRows.map((c) => ({
    kind: 'commit',
    hash: c.hash,
    subject: c.subject,
    sortAt: c.committedAt
  }))

  const items = [...fileItems, ...commitItems].sort((a, b) => {
    if (a.sortAt === b.sortAt) return a.kind === 'file' ? -1 : 1
    return a.sortAt > b.sortAt ? -1 : 1
  })

  return { items }
}

export async function refreshSessionChangesCap(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null,
  opts?: { processHead?: boolean }
): Promise<SessionChangesCap> {
  await syncSessionGitCursor(store, sessionId, workspacePath, hostname)
  if (opts?.processHead !== false) {
    await processHeadAdvanceIfNeeded(store, sessionId, workspacePath, hostname)
  }
  return buildSessionChangesCap(store, sessionId, workspacePath, hostname)
}

export async function handleFileEditToolCompleted(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  workspacePath: string,
  hostname: string | null,
  toolName: string,
  input: unknown
): Promise<SessionChangesCap> {
  registerTouchedPathFromToolCall(store, sessionId, workspaceRoot, toolName, input)
  const now = new Date().toISOString()
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = normalizeToRepoRelativePath(rawPath, workspaceRoot)
    if (!path) continue
    store.updateSessionTouchedPathPendingAt(sessionId, path, now)
  }
  return refreshSessionChangesCap(store, sessionId, workspacePath, hostname, { processHead: false })
}

/** Backfill touched paths from transcript (migration / repair). */
export function rebuildSessionTouchedPathsFromMessages(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string
): void {
  const messages = store.listMessages(sessionId)
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'tool_call') continue
    const content = structured as ToolCallContent
    if (content.status !== 'completed') continue
    registerTouchedPathFromToolCall(store, sessionId, workspaceRoot, content.name, content.input)
  }
}

/** @deprecated Use sessionChangesCap — kept for type re-exports during transition. */
export type { SessionFileEdit }
