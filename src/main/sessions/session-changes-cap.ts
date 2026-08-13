import {
  getOutsideWorkspaceCapFileDiff,
  getPathWorkingTreeNumstat,
  latestReflogSubject,
  listCommitChangedPaths,
  listCommitsInRange,
  resolveHead
} from '../panels/git'
import { resolveActualGitRepoRoot } from '../panels/git-core'
import {
  filePathsForFileEditTool,
  isSessionFileEditTool,
  type SessionFileEdit
} from '../../shared/session-file-edits'
import type { SessionChangesCap, SessionChangesCapItem } from '../../shared/session-changes-cap'
import { parseStructuredContent, type ToolCallContent } from '../../shared/chat-content'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import type { SessionStore } from './store'
import {
  normalizeToRepoRelativePath,
  resolveSessionTouchedAbsolutePath
} from './session-file-edits'
import { isCapPathOutsideWorkspace } from '../../shared/session-touched-path'
import { isClaudePlanPath } from '../../shared/claude-plan-path'
import type { DiffFileChange, DiffFileContentPair } from '../../shared/panel-types'
import { expandTildePath } from '../../shared/project-path-autocomplete'
import { logger } from '../logger'

export function resolveSessionWorkspaceRoot(workspaceRoot: string): string {
  return resolve(expandTildePath(workspaceRoot, homedir()))
}

/** Normalize SDK plan paths (including home-dir `.claude/plans/*`) to a workspace-relative path. */
export function normalizePlanPathForWorkspace(
  raw: string | undefined,
  workspaceRoot: string
): string | null {
  if (!raw?.trim()) return null
  const root = resolveSessionWorkspaceRoot(workspaceRoot)
  let trimmed = raw.trim().replace(/\\/g, '/')
  const home = homedir().replace(/\\/g, '/')
  if (!trimmed.startsWith('/') && trimmed.startsWith(home.replace(/^\//, ''))) {
    trimmed = `/${trimmed}`
  }
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed.replace(/^\.\//, ''))
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    const base = basename(trimmed)
    if (!base || base === '.' || base === '..') return null
    return `.claude/plans/${base}`
  }
  const rel = relative(root, abs).split(/\\/g).join('/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g
const SKIP_LINK_SCHEME = /^(https?|mailto|#):/i

/** Paths from ExitPlanMode's `planFilePath` plus markdown file links in the plan body. */
export function collectPlanCandidatePaths(
  planFilePath: string | undefined,
  planMarkdown: string | undefined,
  workspaceRoot?: string
): string[] {
  const out = new Set<string>()
  if (planFilePath?.trim()) {
    const normalized = workspaceRoot
      ? normalizePlanPathForWorkspace(planFilePath, workspaceRoot)
      : planFilePath.trim()
    if (normalized) out.add(normalized)
  }
  for (const m of planMarkdown?.matchAll(MARKDOWN_LINK_RE) ?? []) {
    const target = m[1]?.trim()
    if (!target || SKIP_LINK_SCHEME.test(target)) continue
    out.add(target)
  }
  return [...out]
}

/** Repo-relative path for mirroring inline ExitPlanMode plan text into the session workspace. */
export function resolveWorkspacePlanMirrorPath(
  workspaceRoot: string,
  planFilePath: string | undefined,
  planMarkdown: string,
  toolUseId: string
): string {
  if (planFilePath?.trim()) {
    const normalized = normalizePlanPathForWorkspace(planFilePath, workspaceRoot)
    if (normalized) return normalized
  }
  const slug = slugFromPlanTitle(planMarkdown)
  const fileName = slug ? `${slug}.md` : `plan-${toolUseId.slice(0, 8)}.md`
  return `.claude/plans/${fileName}`
}

function slugFromPlanTitle(plan: string): string | null {
  const title =
    plan.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? plan.match(/^Plan:\s*(.+)$/im)?.[1]?.trim()
  if (!title) return null
  const slug = title
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || null
}

async function mirrorPlanMarkdownToWorkspace(
  workspaceRoot: string,
  relPath: string,
  planMarkdown: string,
  hostname: string | null
): Promise<void> {
  const abs = join(resolveSessionWorkspaceRoot(workspaceRoot), relPath)
  if (hostname) {
    const { sshExec } = await import('../ssh-exec')
    const { shQuote } = await import('../shell-quote')
    await sshExec(hostname, `mkdir -p ${shQuote(dirname(abs))}`)
  } else {
    await mkdir(dirname(abs), { recursive: true })
  }
  const { writeFileContent } = await import('../panels/files')
  const result = await writeFileContent(abs, planMarkdown, hostname)
  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to mirror plan file')
  }
}

export function registerTouchedPathFromPlanFile(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  planFilePath: string | undefined
): string | null {
  const path = normalizePlanPathForWorkspace(planFilePath, workspaceRoot)
  if (!path) return null
  const now = new Date().toISOString()
  store.registerSessionTouchedPath(sessionId, path, now)
  store.updateSessionTouchedPathPendingAt(sessionId, path, now)
  return path
}

export async function registerPlanFileInSessionChangesCap(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  workspacePath: string,
  hostname: string | null
): Promise<SessionChangesCap> {
  let cap = await refreshSessionChangesCap(store, sessionId, workspacePath, hostname, { processHead: false })
  if (cap.items.some((i) => i.kind === 'file')) return cap

  for (const delayMs of [500, 1000, 2000, 3000]) {
    await new Promise((r) => setTimeout(r, delayMs))
    cap = await refreshSessionChangesCap(store, sessionId, workspacePath, hostname, { processHead: false })
    if (cap.items.some((i) => i.kind === 'file')) break
  }
  return cap
}

/** Drop malformed plan paths (e.g. `Users/me/.claude/plans/foo.md`) and re-register normalized ones. */
function pruneAndNormalizePlanTouchedPaths(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string
): void {
  for (const row of store.listSessionTouchedPaths(sessionId)) {
    const slashPath = row.path.replace(/\\/g, '/')
    if (isCapPathOutsideWorkspace(slashPath) && !isClaudePlanPath(slashPath)) {
      continue
    }
    const normalized = normalizePlanPathForWorkspace(row.path, workspaceRoot)
    if (!normalized) {
      store.deleteSessionTouchedPath(sessionId, row.path)
      continue
    }
    if (normalized !== row.path) {
      store.deleteSessionTouchedPath(sessionId, row.path)
      registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, normalized)
    }
  }
}

/** Mirror every `plan_proposed` message in the transcript to workspace files + touched paths. */
export async function syncSessionPlansFromMessages(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  hostname: string | null
): Promise<void> {
  pruneAndNormalizePlanTouchedPaths(store, sessionId, workspaceRoot)
  const messages = store.listMessages(sessionId)
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'plan_proposed') continue
    const plan = structured.plan
    if (!plan?.trim()) continue
    const toolUseId = structured.toolUseId || String(message.id)
    try {
      const mirrorPath = resolveWorkspacePlanMirrorPath(
        workspaceRoot,
        structured.planFilePath,
        plan,
        toolUseId
      )
      await mirrorPlanMarkdownToWorkspace(workspaceRoot, mirrorPath, plan, hostname)
      registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, mirrorPath)
      for (const raw of collectPlanCandidatePaths(structured.planFilePath, plan, workspaceRoot)) {
        if (raw !== mirrorPath) registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, raw)
      }
    } catch (err) {
      logger.warn('syncSessionPlansFromMessages: failed to mirror plan', {
        sessionId,
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

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

async function fallbackFileStats(
  workspaceRoot: string,
  relPath: string,
  hostname: string | null
): Promise<{ additions: number; deletions: number } | null> {
  const abs = isCapPathOutsideWorkspace(relPath)
    ? resolveSessionTouchedAbsolutePath(relPath, workspaceRoot)
    : join(resolveSessionWorkspaceRoot(workspaceRoot), relPath)
  try {
    if (hostname) {
      const { readFileForPreview } = await import('../panels/files')
      const result = await readFileForPreview(abs, hostname)
      if (result.kind !== 'text' && result.kind !== 'html') return null
      const lines = result.content.split('\n').length
      return lines > 0 ? { additions: lines, deletions: 0 } : null
    }
    const content = await readFile(abs, 'utf8')
    const lines = content.split('\n').length
    return lines > 0 ? { additions: lines, deletions: 0 } : null
  } catch {
    return null
  }
}

function asToolInputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Content before the session's first completed file-edit tool call on `capPath`. */
export function sessionFileBaselineFromMessages(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  capPath: string
): string {
  const targetAbs = resolveSessionTouchedAbsolutePath(capPath, workspaceRoot)
  for (const message of store.listMessages(sessionId)) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'tool_call') continue
    const content = structured as ToolCallContent
    if (content.status !== 'completed' || !isSessionFileEditTool(content.name)) continue
    for (const rawPath of filePathsForFileEditTool(content.name, content.input)) {
      const normalized = normalizeToRepoRelativePath(rawPath, workspaceRoot)
      if (!normalized) continue
      const editAbs = resolveSessionTouchedAbsolutePath(normalized, workspaceRoot)
      if (editAbs !== targetAbs) continue
      const obj = asToolInputRecord(content.input)
      if (content.name === 'Write') return ''
      if (content.name === 'Edit' && typeof obj.old_string === 'string') return obj.old_string
      if (content.name === 'MultiEdit' && Array.isArray(obj.edits) && obj.edits.length > 0) {
        const first = asToolInputRecord(obj.edits[0])
        if (typeof first.old_string === 'string') return first.old_string
      }
    }
  }
  return ''
}

export async function getSessionCapOutsideFileDiff(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<{ file: DiffFileChange; pair: DiffFileContentPair } | null> {
  if (await isCapPathInGitRepo(workspacePath, capPath, hostname)) return null
  const absPath = resolveSessionTouchedAbsolutePath(capPath, workspacePath)
  const baseline = sessionFileBaselineFromMessages(store, sessionId, workspacePath, capPath)
  return getOutsideWorkspaceCapFileDiff(absPath, baseline, hostname)
}

async function capPathWorkingTreeStats(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<{ additions: number; deletions: number } | null> {
  if (!(await isCapPathInGitRepo(workspacePath, capPath, hostname))) {
    const diff = await getSessionCapOutsideFileDiff(store, sessionId, workspacePath, capPath, hostname)
    if (diff) return { additions: diff.file.additions, deletions: diff.file.deletions }
    return fallbackFileStats(workspacePath, capPath, hostname)
  }
  const resolvedWorkspace = resolveSessionWorkspaceRoot(workspacePath)
  let stats = await getPathWorkingTreeNumstat(resolvedWorkspace, capPath, hostname)
  if (!stats && isCapPathOutsideWorkspace(capPath)) {
    const rel = await capPathToGitRelative(workspacePath, capPath, hostname)
    if (rel) stats = await getPathWorkingTreeNumstat(resolvedWorkspace, rel, hostname)
  }
  if (!stats) stats = await fallbackFileStats(workspacePath, capPath, hostname)
  return stats
}

async function isCapPathInGitRepo(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<boolean> {
  try {
    const repoRootRaw = await resolveActualGitRepoRoot(workspacePath, hostname)
    if (!repoRootRaw) return false
    const repoRoot = resolve(await realpath(repoRootRaw))
    let abs = resolve(resolveSessionTouchedAbsolutePath(capPath, workspacePath))
    try {
      abs = resolve(await realpath(abs))
    } catch {
      /* cap file may not exist on disk yet */
    }
    return abs === repoRoot || abs.startsWith(`${repoRoot}/`)
  } catch {
    return false
  }
}

async function capPathToGitRelative(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<string | null> {
  if (!(await isCapPathInGitRepo(workspacePath, capPath, hostname))) return null
  try {
    const repoRootRaw = await resolveActualGitRepoRoot(workspacePath, hostname)
    if (!repoRootRaw) return null
    const repoRoot = resolve(await realpath(repoRootRaw))
    let abs = resolve(resolveSessionTouchedAbsolutePath(capPath, workspacePath))
    try {
      abs = resolve(await realpath(abs))
    } catch {
      /* cap file may not exist on disk yet */
    }
    const rel = relative(repoRoot, abs).split(/\\/g).join('/')
    return rel && !rel.startsWith('..') ? rel : null
  } catch {
    return null
  }
}

async function capPathOpensInFilesTab(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<boolean> {
  return !(await isCapPathInGitRepo(workspacePath, capPath, hostname))
}

async function capItemPathForNavigation(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<string> {
  const rel = await capPathToGitRelative(workspacePath, capPath, hostname)
  return rel ?? capPath
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
    const stats = await capPathWorkingTreeStats(store, sessionId, workspacePath, row.path, hostname)
    if (!stats) continue
    const sortAt = now
    store.updateSessionTouchedPathPendingAt(sessionId, row.path, sortAt)
    fileItems.push({
      kind: 'file',
      path: await capItemPathForNavigation(workspacePath, row.path, hostname),
      additions: stats.additions,
      deletions: stats.deletions,
      opensInFilesTab: await capPathOpensInFilesTab(workspacePath, row.path, hostname),
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
  await syncSessionPlansFromMessages(store, sessionId, workspacePath, hostname)
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
    if (structured?.kind === 'plan_proposed') {
      for (const raw of collectPlanCandidatePaths(structured.planFilePath, structured.plan, workspaceRoot)) {
        registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, raw)
      }
      continue
    }
    if (structured?.kind !== 'tool_call') continue
    const content = structured as ToolCallContent
    if (content.status !== 'completed') continue
    registerTouchedPathFromToolCall(store, sessionId, workspaceRoot, content.name, content.input)
  }
}

/** @deprecated Use sessionChangesCap — kept for type re-exports during transition. */
export type { SessionFileEdit }
