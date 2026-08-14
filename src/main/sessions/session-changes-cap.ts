import {
  getOutsideWorkspaceCapFileDiff,
  getOutsideWorkspaceCapTextPairDiff,
  getPathWorkingTreeNumstat,
  getWorkingTreeNumstatMap,
  latestReflogSubject,
  listCommitChangedPaths,
  listCommitsInRange,
  resolveHead,
  getFileDiff,
  type WorkingTreeNumstat
} from '../panels/git'
import {
  filePathsForFileEditTool,
  isSessionFileEditTool,
  type SessionFileEdit
} from '../../shared/session-file-edits'
import type { SessionChangesCap, SessionChangesCapItem } from '../../shared/session-changes-cap'
import { parseStructuredContent, type ToolCallContent } from '../../shared/chat-content'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { SessionStore } from './store'
import {
  normalizeCapStoragePath,
  normalizeToRepoRelativePath,
  resolveCapGitContext,
  resolveCapPathAbsolute,
  resolveSessionTouchedAbsolutePath,
  resolveToolFileAbsolutePath
} from './session-file-edits'
import { isCapPathOutsideWorkspace } from '../../shared/session-touched-path'
import { isClaudePlanPath } from '../../shared/claude-plan-path'
import { findPlanCapEdition, planCapReviewDiffStats } from '../../shared/plan-cap-editions'
import {
  normalizePlanPathForWorkspace,
  resolveSessionWorkspaceRoot,
  resolveWorkspacePlanMirrorPath
} from '../../shared/plan-mirror-path'
import type { DiffFileChange, DiffFileContentPair } from '../../shared/panel-types'

export {
  normalizePlanPathForWorkspace,
  resolveSessionWorkspaceRoot,
  resolveWorkspacePlanMirrorPath
} from '../../shared/plan-mirror-path'

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
  return refreshSessionChangesCap(store, sessionId, workspacePath, hostname, { processHead: false })
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

/** Register touched paths for `plan_proposed` messages. Claude owns on-disk plan files. */
export async function syncSessionPlansFromMessages(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  _hostname: string | null
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
    const planPath = resolveWorkspacePlanMirrorPath(
      workspaceRoot,
      structured.planFilePath,
      plan,
      toolUseId
    )
    registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, planPath)
    for (const raw of collectPlanCandidatePaths(structured.planFilePath, plan, workspaceRoot)) {
      if (raw !== planPath) registerTouchedPathFromPlanFile(store, sessionId, workspaceRoot, raw)
    }
  }
}

function isPullLikeReflog(subject: string): boolean {
  const s = subject.toLowerCase()
  if (s.includes('pull')) return true
  if (s.includes('fetch') && (s.includes('merge') || s.includes('fast-forward'))) return true
  return false
}

/** True when a Bash command may revert, commit, or otherwise mutate git state affecting the cap. */
export function bashCommandMayAffectSessionChanges(command: string): boolean {
  const normalized = command.replace(/\\(?:\r?\n|\r)/g, ' ').trim()
  return /\bgit(?:\s|$|\s+[-\w@]+=)*\s+(?:revert|reset|checkout|restore|clean|commit|merge|cherry-pick|am\b|stash(?:\s+(?:pop|apply|restore)))/i.test(
    normalized
  )
}

type NumstatMap = Map<string, WorkingTreeNumstat>

function lookupBatchedNumstat(map: NumstatMap, gitPath: string): WorkingTreeNumstat | null {
  const direct = map.get(gitPath)
  if (direct) {
    return direct.additions > 0 || direct.deletions > 0 ? direct : null
  }
  for (const [path, stats] of map) {
    if (
      path === gitPath ||
      path.endsWith(`/${gitPath}`) ||
      gitPath.endsWith(`/${path}`)
    ) {
      return stats.additions > 0 || stats.deletions > 0 ? stats : null
    }
  }
  return null
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

export async function registerTouchedPathFromToolCallAsync(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null,
  toolName: string,
  input: unknown,
  projectPath: string
): Promise<void> {
  if (!isSessionFileEditTool(toolName)) return
  const now = new Date().toISOString()
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = await normalizeCapStoragePath(rawPath, workspacePath, hostname, projectPath)
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
  capPath: string,
  hostname: string | null
): Promise<{ additions: number; deletions: number } | null> {
  const abs = await resolveCapPathAbsolute(capPath, workspaceRoot, hostname)
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
export async function sessionFileBaselineFromMessages(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  capPath: string,
  hostname: string | null,
  projectPath: string
): Promise<string> {
  const targetAbs = resolve(await resolveCapPathAbsolute(capPath, workspacePath, hostname))
  for (const message of store.listMessages(sessionId)) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'tool_call') continue
    const content = structured as ToolCallContent
    if (content.status !== 'completed' || !isSessionFileEditTool(content.name)) continue
    for (const rawPath of filePathsForFileEditTool(content.name, content.input)) {
      const toolAbs = resolveToolFileAbsolutePath(rawPath, workspacePath, projectPath)
      if (!toolAbs || resolve(toolAbs) !== targetAbs) continue
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

async function readCapPathText(
  capPath: string,
  workspacePath: string,
  hostname: string | null
): Promise<string | null> {
  const absPath = await resolveCapPathAbsolute(capPath, workspacePath, hostname)
  if (hostname) {
    const { readFileForPreview } = await import('../panels/files')
    const result = await readFileForPreview(absPath, hostname)
    if (result.kind !== 'text' && result.kind !== 'html') return null
    return result.content
  }
  try {
    return await readFile(absPath, 'utf8')
  } catch {
    return null
  }
}

export async function getSessionCapOutsideFileDiff(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  capPath: string,
  hostname: string | null,
  projectPath?: string
): Promise<{ file: DiffFileChange; pair: DiffFileContentPair } | null> {
  const projectRoot = projectPath ?? workspacePath
  if (isClaudePlanPath(capPath)) {
    const absPath = await resolveCapPathAbsolute(capPath, workspacePath, hostname)
    const onDisk = await readCapPathText(capPath, workspacePath, hostname)
    if (onDisk !== null) {
      const baseline = await sessionFileBaselineFromMessages(
        store,
        sessionId,
        workspacePath,
        capPath,
        hostname,
        projectRoot
      )
      return getOutsideWorkspaceCapTextPairDiff(absPath, baseline, onDisk, hostname)
    }
    const edition = findPlanCapEdition(store.listMessages(sessionId), capPath)
    if (edition) {
      return getOutsideWorkspaceCapTextPairDiff(
        absPath,
        edition.previous ?? '',
        edition.current,
        hostname
      )
    }
  }
  if (await isCapPathInGitRepo(workspacePath, capPath, hostname)) return null
  const absPath = await resolveCapPathAbsolute(capPath, workspacePath, hostname)
  const baseline = await sessionFileBaselineFromMessages(
    store,
    sessionId,
    workspacePath,
    capPath,
    hostname,
    projectRoot
  )
  return getOutsideWorkspaceCapFileDiff(absPath, baseline, hostname)
}

/** Working-tree diff for a cap file in git (including nested repos when session cwd is `~`). */
export async function getSessionCapGitFileDiff(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<DiffFileChange | null> {
  const ctx = await resolveCapGitContext(capPath, workspacePath, hostname)
  if (!ctx) return null
  return getFileDiff(ctx.repoRoot, ctx.gitRelative, hostname)
}

async function capPathWorkingTreeStats(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  capPath: string,
  hostname: string | null,
  projectPath: string,
  numstatByRepo: Map<string, NumstatMap>
): Promise<{ additions: number; deletions: number } | null> {
  if (isClaudePlanPath(capPath)) {
    const diskStats = await fallbackFileStats(workspacePath, capPath, hostname)
    if (diskStats) return diskStats
    const planStats = planCapReviewDiffStats(store.listMessages(sessionId), capPath)
    if (planStats) return planStats
  }
  if (!(await isCapPathInGitRepo(workspacePath, capPath, hostname))) {
    const diff = await getSessionCapOutsideFileDiff(
      store,
      sessionId,
      workspacePath,
      capPath,
      hostname,
      projectPath
    )
    if (diff) return { additions: diff.file.additions, deletions: diff.file.deletions }
    return fallbackFileStats(workspacePath, capPath, hostname)
  }
  const ctx = await resolveCapGitContext(capPath, workspacePath, hostname)
  const gitPath = ctx?.gitRelative ?? capPath
  const repoRoot = ctx?.repoRoot ?? resolveSessionWorkspaceRoot(workspacePath)
  const repoMap = numstatByRepo.get(repoRoot)
  if (repoMap) {
    const fromMap = lookupBatchedNumstat(repoMap, gitPath)
    if (fromMap) return fromMap
    return null
  }
  return getPathWorkingTreeNumstat(repoRoot, gitPath, hostname)
}

async function capPathToGitRelative(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<string | null> {
  if (isClaudePlanPath(capPath)) return null
  const ctx = await resolveCapGitContext(capPath, workspacePath, hostname)
  return ctx?.gitRelative ?? null
}

async function isCapPathInGitRepo(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<boolean> {
  if (isClaudePlanPath(capPath)) return false
  return (await capPathToGitRelative(workspacePath, capPath, hostname)) !== null
}

async function capPathOpensInFilesTab(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<boolean> {
  return !(await isCapPathInGitRepo(workspacePath, capPath, hostname))
}

async function canonicalizeStoredCapPath(
  storedPath: string,
  workspacePath: string,
  hostname: string | null,
  projectPath: string
): Promise<string> {
  if (isClaudePlanPath(storedPath)) return storedPath

  const abs = await resolveCapPathAbsolute(storedPath, workspacePath, hostname)
  const fromAbs = await normalizeCapStoragePath(abs, workspacePath, hostname, projectPath)
  if (fromAbs) return fromAbs

  const fromRaw = await normalizeCapStoragePath(storedPath, workspacePath, hostname, projectPath)
  if (fromRaw) return fromRaw

  if (projectPath !== workspacePath) {
    const fromProject = await normalizeCapStoragePath(
      resolveSessionTouchedAbsolutePath(storedPath, projectPath),
      workspacePath,
      hostname,
      projectPath
    )
    if (fromProject) return fromProject
  }

  return storedPath
}

async function capItemPathForNavigation(
  workspacePath: string,
  capPath: string,
  hostname: string | null
): Promise<string> {
  if (isClaudePlanPath(capPath)) return capPath
  return (await capPathToGitRelative(workspacePath, capPath, hostname)) ?? capPath
}

export async function buildSessionChangesCap(
  store: SessionStore,
  sessionId: string,
  workspacePath: string,
  hostname: string | null
): Promise<SessionChangesCap> {
  const session = store.getSession(sessionId)
  const projectPath = session?.projectPath ?? workspacePath
  const paths = store.listSessionTouchedPaths(sessionId)
  const now = new Date().toISOString()
  const fileItems: SessionChangesCapItem[] = []

  const canonicalRows: Array<{ row: (typeof paths)[number]; capPath: string }> = []
  const repoRoots = new Set<string>()

  for (const row of paths) {
    const capPath = await canonicalizeStoredCapPath(row.path, workspacePath, hostname, projectPath)
    if (capPath !== row.path) {
      store.deleteSessionTouchedPath(sessionId, row.path)
      store.registerSessionTouchedPath(sessionId, capPath, row.firstTouchedAt)
      if (row.lastPendingAt) {
        store.updateSessionTouchedPathPendingAt(sessionId, capPath, row.lastPendingAt)
      }
    }
    canonicalRows.push({ row, capPath })
    if (!isClaudePlanPath(capPath) && (await isCapPathInGitRepo(workspacePath, capPath, hostname))) {
      const ctx = await resolveCapGitContext(capPath, workspacePath, hostname)
      repoRoots.add(ctx?.repoRoot ?? resolveSessionWorkspaceRoot(workspacePath))
    }
  }

  const numstatByRepo = new Map<string, NumstatMap>()
  await Promise.all(
    [...repoRoots].map(async (repoRoot) => {
      numstatByRepo.set(repoRoot, await getWorkingTreeNumstatMap(repoRoot, hostname))
    })
  )

  for (const { capPath } of canonicalRows) {
    const stats = await capPathWorkingTreeStats(
      store,
      sessionId,
      workspacePath,
      capPath,
      hostname,
      projectPath,
      numstatByRepo
    )
    if (!stats) {
      store.deleteSessionTouchedPath(sessionId, capPath)
      continue
    }
    const sortAt = now
    store.updateSessionTouchedPathPendingAt(sessionId, capPath, sortAt)
    fileItems.push({
      kind: 'file',
      path: await capItemPathForNavigation(workspacePath, capPath, hostname),
      additions: stats.additions,
      deletions: stats.deletions,
      opensInFilesTab: await capPathOpensInFilesTab(workspacePath, capPath, hostname),
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

export async function registerFileEditToolTouchedPaths(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  workspacePath: string,
  hostname: string | null,
  toolName: string,
  input: unknown,
  projectPath?: string
): Promise<void> {
  const project = projectPath ?? workspaceRoot
  await registerTouchedPathFromToolCallAsync(
    store,
    sessionId,
    workspacePath,
    hostname,
    toolName,
    input,
    project
  )
  const now = new Date().toISOString()
  for (const rawPath of filePathsForFileEditTool(toolName, input)) {
    const path = await normalizeCapStoragePath(rawPath, workspacePath, hostname, project)
    if (!path) continue
    store.updateSessionTouchedPathPendingAt(sessionId, path, now)
  }
}

export async function handleFileEditToolCompleted(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  workspacePath: string,
  hostname: string | null,
  toolName: string,
  input: unknown,
  projectPath?: string
): Promise<SessionChangesCap> {
  await registerFileEditToolTouchedPaths(
    store,
    sessionId,
    workspaceRoot,
    workspacePath,
    hostname,
    toolName,
    input,
    projectPath
  )
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
