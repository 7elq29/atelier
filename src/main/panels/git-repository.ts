/**
 * Session-scoped git state for the Diff panel (VS Code SCM model): one batched
 * status fetch per refresh, cached snapshots, lazy per-file hunks, lazy
 * commits/worktrees. Remote devpod sessions use multiplexed SSH via ssh-exec.ts.
 */
import type { CommitInfo, DiffFileChange, DiffFileContentPair, DiffFileStatus, DiffSummary, WorktreeInfo } from '../../shared/panel-types'
import { countPlanReviewDiffStats } from '../../shared/plan-review-diff'
import { readFileForPreview } from './files'
import { isAbsolute, join, resolve } from 'node:path'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { warmSshMux } from '../ssh-exec'
import {
  clearGitRepoRootCache,
  GIT_NO_EXTERNAL_DIFF,
  GIT_PATCH_CONFIG_ARGS,
  gitPatchOutputUsable,
  numstatPathForGit,
  parseNumstatLines,
  parseUnifiedDiff,
  pickDefaultCommitFile,
  pickParsedDiffFile,
  resolveGitRepoRoot,
  runGit,
  runGitAtRepoRoot,
  runGitDiffPatch,
  runGitShowPatch
} from './git-core'

const EMPTY_TREE = '4b825dc642cb6eb6a060e54bf8d69288fbee4904'

/** Commits with at most this many files use one full `git show -U3` on open (typical agent commits). */
const COMMIT_OPEN_FULL_PATCH_MAX_FILES = 40
const WORKING_TREE_FULL_PATCH_MAX_FILES = COMMIT_OPEN_FULL_PATCH_MAX_FILES

function repoKey(projectPath: string, sshHost?: string | null): string {
  return `${sshHost ?? 'local'}\0${projectPath}`
}

function mergeUntrackedPaths(files: DiffFileChange[], untrackedStdout: string): DiffFileChange[] {
  const seen = new Set(files.map((f) => f.path))
  const merged = [...files]
  for (const line of untrackedStdout.split('\n')) {
    const path = line.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    merged.push({ path, status: 'added', additions: 0, deletions: 0, hunks: [] })
  }
  return merged
}

/** Tracked working-tree changes vs HEAD — excludes untracked scan (slow on large repos). */
async function fetchTrackedWorkingTreeChanges(
  projectPath: string,
  sshHost?: string | null
): Promise<{ isRepo: boolean; branch: string | null; hasHead: boolean; files: DiffFileChange[] }> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, hasHead: false, files: [] }
  }

  const branchRes = await runGitAtRepoRoot(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], sshHost)
  const branchRaw = branchRes.stdout.trim()
  const branch = branchRaw === 'HEAD' || !branchRaw ? null : branchRaw

  const hasHead = (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  const diffTarget = hasHead ? 'HEAD' : EMPTY_TREE
  const numstat = await runGitAtRepoRoot(projectPath, ['diff', '--no-color', '--numstat', diffTarget], sshHost)

  const files = parseNumstatLines(numstat.stdout.split('\n'))
  return { isRepo: true, branch, hasHead, files }
}

interface RepoCache {
  summary: DiffSummary
  hasHead: boolean
  commits: CommitInfo[] | null
  worktrees: WorktreeInfo[] | null
  fetchedAt: number
}

type CommitDiffCacheKey = string

export type WorkingTreeUpdateListener = (
  projectPath: string,
  sshHost: string | null | undefined,
  summary: DiffSummary
) => void

class GitRepositoryManager {
  private readonly cache = new Map<string, RepoCache>()
  private readonly inFlight = new Map<string, Promise<DiffSummary>>()
  private readonly untrackedInFlight = new Map<string, Promise<void>>()
  private readonly untrackedGeneration = new Map<string, number>()
  private readonly workingTreeListeners = new Set<WorkingTreeUpdateListener>()
  private readonly commitDiffCache = new Map<CommitDiffCacheKey, DiffSummary>()
  private readonly commitFileDiffCache = new Map<CommitDiffCacheKey, DiffFileChange>()

  private commitCachePrefix(projectPath: string, sshHost?: string | null): string {
    return `${repoKey(projectPath, sshHost)}\0`
  }

  private dropCommitCachesForRepo(projectPath: string, sshHost?: string | null): void {
    const prefix = this.commitCachePrefix(projectPath, sshHost)
    for (const k of this.commitDiffCache.keys()) {
      if (k.startsWith(prefix)) this.commitDiffCache.delete(k)
    }
    for (const k of this.commitFileDiffCache.keys()) {
      if (k.startsWith(prefix)) this.commitFileDiffCache.delete(k)
    }
  }

  invalidate(projectPath: string, sshHost?: string | null): void {
    const key = repoKey(projectPath, sshHost)
    clearGitRepoRootCache(projectPath, sshHost)
    this.cache.delete(key)
    this.untrackedGeneration.set(key, (this.untrackedGeneration.get(key) ?? 0) + 1)
    this.dropCommitCachesForRepo(projectPath, sshHost)
  }

  onWorkingTreeUpdated(listener: WorkingTreeUpdateListener): () => void {
    this.workingTreeListeners.add(listener)
    return () => this.workingTreeListeners.delete(listener)
  }

  private notifyWorkingTreeUpdated(
    projectPath: string,
    sshHost: string | null | undefined,
    summary: DiffSummary
  ): void {
    for (const listener of this.workingTreeListeners) {
      listener(projectPath, sshHost, summary)
    }
  }

  private scheduleUntrackedFetch(projectPath: string, sshHost?: string | null): void {
    const key = repoKey(projectPath, sshHost)
    const gen = (this.untrackedGeneration.get(key) ?? 0) + 1
    this.untrackedGeneration.set(key, gen)
    if (this.untrackedInFlight.has(key)) return

    const work = (async (): Promise<void> => {
      try {
        const untracked = await runGitAtRepoRoot(
          projectPath,
          ['ls-files', '--others', '--exclude-standard'],
          sshHost
        )
        if (this.untrackedGeneration.get(key) !== gen) {
          this.scheduleUntrackedFetch(projectPath, sshHost)
          return
        }
        const entry = this.cache.get(key)
        if (!entry?.summary.isRepo) return

        const mergedFiles = mergeUntrackedPaths(entry.summary.files, untracked.stdout)
        if (mergedFiles.length === entry.summary.files.length) return

        entry.summary = { ...entry.summary, files: mergedFiles }
        entry.fetchedAt = Date.now()
        this.notifyWorkingTreeUpdated(projectPath, sshHost, entry.summary)
      } finally {
        this.untrackedInFlight.delete(key)
      }
    })()

    this.untrackedInFlight.set(key, work)
  }

  async warmRemote(sshHost: string): Promise<void> {
    await warmSshMux(sshHost)
  }

  /** Cached repo membership — avoids running the full working-tree status script for commit history. */
  private async ensureIsRepo(projectPath: string, sshHost?: string | null): Promise<boolean> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (entry) return entry.summary.isRepo
    const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
    return inside.code === 0 && inside.stdout.trim() === 'true'
  }

  private seedCommitOpenCaches(
    projectPath: string,
    commit: string,
    sshHost: string | null | undefined,
    parsed: DiffFileChange[],
    firstPath: string | null
  ): DiffSummary {
    const listFiles = parsed.map((f) => (f.path === firstPath ? f : { ...f, hunks: [] }))
    const listSummary: DiffSummary = { isRepo: true, branch: null, files: listFiles.map((f) => ({ ...f, hunks: [] })) }
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`
    this.commitDiffCache.set(cacheKey, listSummary)
    const prefix = this.commitCachePrefix(projectPath, sshHost)
    for (const f of parsed) {
      this.commitFileDiffCache.set(`${prefix}${commit}\0${f.path}`, f)
    }
    return { isRepo: true, branch: null, files: listFiles }
  }

  /**
   * Open a commit in Diff › Commits: file list + first file hunks when cheap.
   * Skips working-tree refresh; small commits use a single `git show -U3`.
   */
  async loadCommitPanelOpen(projectPath: string, commit: string, sshHost?: string | null): Promise<DiffSummary> {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`
    const cachedList = this.commitDiffCache.get(cacheKey)
    if (cachedList) {
      const firstPath = pickDefaultCommitFile(cachedList.files)
      if (!firstPath) return cachedList
      const file = await this.loadCommitFileDiff(projectPath, commit, firstPath, sshHost)
      if (!file) return cachedList
      return {
        ...cachedList,
        files: cachedList.files.map((f) => (f.path === firstPath ? file : f))
      }
    }

    if (!(await this.ensureIsRepo(projectPath, sshHost))) {
      return { isRepo: false, branch: null, files: [] }
    }

    const res = await runGitAtRepoRoot(
      projectPath,
      ['show', '-m', '--first-parent', '--no-color', '--numstat', '--format=', commit],
      sshHost
    )
    if (res.code !== 0) return { isRepo: true, branch: null, files: [] }
    const files = parseNumstatLines(res.stdout.split('\n')).map((f) => ({ ...f, hunks: [] }))
    if (files.length === 0) {
      const empty: DiffSummary = { isRepo: true, branch: null, files: [] }
      this.commitDiffCache.set(cacheKey, empty)
      return empty
    }

    if (files.length <= COMMIT_OPEN_FULL_PATCH_MAX_FILES) {
      const full = await runGitShowPatch(
        projectPath,
        ['-m', '--first-parent', '--no-color', '-U3', '--format=', commit],
        sshHost
      )
      if (gitPatchOutputUsable(full.code, full.stdout)) {
        const parsed = parseUnifiedDiff(full.stdout)
        if (parsed.length > 0) {
          const firstPath = pickDefaultCommitFile(parsed)
          return this.seedCommitOpenCaches(projectPath, commit, sshHost, parsed, firstPath)
        }
      }
    }

    const listSummary: DiffSummary = { isRepo: true, branch: null, files }
    this.commitDiffCache.set(cacheKey, listSummary)

    const firstPath = pickDefaultCommitFile(files)
    if (!firstPath) return listSummary

    const file = await this.loadCommitFileDiff(projectPath, commit, firstPath, sshHost)
    if (!file) return listSummary
    return {
      ...listSummary,
      files: files.map((f) => (f.path === firstPath ? file : f))
    }
  }

  async refreshChanges(projectPath: string, sshHost?: string | null, force = false): Promise<DiffSummary> {
    const key = repoKey(projectPath, sshHost)
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.fetchedAt < 2500) {
      return cached.summary
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const work = (async (): Promise<DiffSummary> => {
      const parsed = await fetchTrackedWorkingTreeChanges(projectPath, sshHost)
      if (!parsed.isRepo) {
        const summary: DiffSummary = { isRepo: false, branch: null, files: [] }
        this.cache.set(key, { summary, hasHead: false, commits: null, worktrees: null, fetchedAt: Date.now() })
        return summary
      }
      const summary: DiffSummary = {
        isRepo: true,
        branch: parsed.branch,
        files: parsed.files.map((f) => ({ ...f, hunks: [] }))
      }
      this.cache.set(key, {
        summary,
        hasHead: parsed.hasHead,
        commits: cached?.commits ?? null,
        worktrees: cached?.worktrees ?? null,
        fetchedAt: Date.now()
      })
      this.scheduleUntrackedFetch(projectPath, sshHost)
      return summary
    })()

    this.inFlight.set(key, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * Fill working-tree file hunks — one full patch when the changeset is small,
   * otherwise parallel per-file loads (untracked files still need per-path diff).
   */
  async hydrateWorkingTreeHunks(
    projectPath: string,
    sshHost?: string | null,
    baseSummary?: DiffSummary
  ): Promise<DiffSummary> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    const base = baseSummary ?? entry?.summary
    if (!base?.isRepo || base.files.length === 0) {
      return base ?? { isRepo: false, branch: null, files: [] }
    }
    if (base.files.every((f) => f.hunks.length > 0)) return base

    const hasHead = entry?.hasHead ?? (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    const target = hasHead ? 'HEAD' : EMPTY_TREE

    let files = base.files

    if (files.length <= WORKING_TREE_FULL_PATCH_MAX_FILES) {
      const patch = await runGitDiffPatch(projectPath, ['--no-color', '-U3', target], sshHost)
      if (gitPatchOutputUsable(patch.code, patch.stdout)) {
        const parsed = parseUnifiedDiff(patch.stdout)
        files = files.map((f) => {
          const withHunks = pickParsedDiffFile(parsed, f.path, f.path)
          if (!withHunks?.hunks.length) return f
          return {
            ...f,
            ...withHunks,
            path: f.path,
            status: f.status,
            additions: f.additions || withHunks.additions,
            deletions: f.deletions || withHunks.deletions
          }
        })
      }
    }

    const needsLoad = files.filter((f) => f.hunks.length === 0)
    if (needsLoad.length > 0) {
      const loaded = await Promise.all(
        needsLoad.map(async (f) => {
          const detail = await this.loadFileDiff(projectPath, f.path, sshHost)
          return detail ?? f
        })
      )
      const byPath = new Map(loaded.map((f) => [f.path, f]))
      files = files.map((f) => byPath.get(f.path) ?? f)
    }

    const hydrated: DiffSummary = { ...base, files }
    if (entry) {
      entry.summary = hydrated
    } else {
      this.cache.set(key, {
        summary: hydrated,
        hasHead,
        commits: null,
        worktrees: null,
        fetchedAt: Date.now()
      })
    }
    return hydrated
  }

  /** File list for a single commit (numstat; empty hunks until loadCommitFileDiff). */
  async loadCommitDiff(projectPath: string, commit: string, sshHost?: string | null): Promise<DiffSummary> {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}`
    const cached = this.commitDiffCache.get(cacheKey)
    if (cached) return cached

    if (!(await this.ensureIsRepo(projectPath, sshHost))) {
      return { isRepo: false, branch: null, files: [] }
    }

    // -m --first-parent: merge commits and root commits get a real patch (plain `git show` is often empty).
    const res = await runGitAtRepoRoot(
      projectPath,
      ['show', '-m', '--first-parent', '--no-color', '--numstat', '--format=', commit],
      sshHost
    )
    if (res.code !== 0) return { isRepo: true, branch: null, files: [] }
    const files = parseNumstatLines(res.stdout.split('\n')).map((f) => ({ ...f, hunks: [] }))
    const result = { isRepo: true, branch: null, files }
    this.commitDiffCache.set(cacheKey, result)
    return result
  }

  private mergeCommitFileStub(stub: DiffFileChange, parsed: DiffFileChange): DiffFileChange {
    return {
      ...stub,
      ...parsed,
      path: stub.path,
      status: stub.status,
      additions: stub.additions || parsed.additions,
      deletions: stub.deletions || parsed.deletions,
      hunks: parsed.hunks
    }
  }

  private async commitDiffParentBase(
    projectPath: string,
    commit: string,
    sshHost?: string | null
  ): Promise<string> {
    const parentRev = await runGit(projectPath, ['rev-parse', `${commit}^`], sshHost)
    return parentRev.code === 0 && parentRev.stdout.trim() ? `${commit}^` : EMPTY_TREE
  }

  async loadCommitFileDiff(
    projectPath: string,
    commit: string,
    filePath: string,
    sshHost?: string | null
  ): Promise<DiffFileChange | null> {
    const cacheKey = `${this.commitCachePrefix(projectPath, sshHost)}${commit}\0${filePath}`
    const cached = this.commitFileDiffCache.get(cacheKey)
    if (cached) return cached

    const list = await this.loadCommitDiff(projectPath, commit, sshHost)
    const stub = list.files.find((f) => f.path === filePath)
    const gitPath = numstatPathForGit(filePath)

    const parseForFile = (stdout: string): DiffFileChange | undefined => {
      const parsed = parseUnifiedDiff(stdout)
      return pickParsedDiffFile(parsed, filePath, gitPath)
    }

    let parsed: DiffFileChange | undefined

    const parentRev = await runGit(projectPath, ['rev-parse', `${commit}^`], sshHost)
    if (parentRev.code === 0 && parentRev.stdout.trim()) {
      const blobDiff = await runGitDiffPatch(
        projectPath,
        ['--no-color', '-U3', `${commit}^:${gitPath}`, `${commit}:${gitPath}`],
        sshHost
      )
      if (gitPatchOutputUsable(blobDiff.code, blobDiff.stdout)) {
        parsed = parseForFile(blobDiff.stdout)
      }
    }

    const base = await this.commitDiffParentBase(projectPath, commit, sshHost)
    if (!parsed?.hunks.length) {
      const diffRes = await runGitDiffPatch(
        projectPath,
        ['--no-color', '-U3', base, commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(diffRes.code, diffRes.stdout)) {
        parsed = parseForFile(diffRes.stdout) ?? parsed
      }
    }

    if (!parsed?.hunks.length) {
      const show = await runGitShowPatch(
        projectPath,
        ['-m', '--first-parent', '--no-color', '-U3', '--format=', commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(show.code, show.stdout)) {
        parsed = parseForFile(show.stdout) ?? parsed
      }
    }

    if (!parsed?.hunks.length) {
      const showPlain = await runGitShowPatch(
        projectPath,
        ['--no-color', '-U3', '--format=', commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(showPlain.code, showPlain.stdout)) {
        parsed = parseForFile(showPlain.stdout) ?? parsed
      }
    }

    let result: DiffFileChange | null
    if (parsed?.hunks.length) {
      result = stub ? this.mergeCommitFileStub(stub, parsed) : parsed
    } else {
      result = stub ? { ...stub, hunks: [] } : null
    }
    if (result) this.commitFileDiffCache.set(cacheKey, result)
    return result
  }

  async loadFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    const hasHead = entry?.hasHead ?? (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    const target = hasHead ? 'HEAD' : EMPTY_TREE

    const tracked = await runGitAtRepoRoot(projectPath, ['ls-files', '--error-unmatch', '--', filePath], sshHost)
    let diff = await runGitDiffPatch(projectPath, ['--no-color', '-U3', target, '--', filePath], sshHost)
    if (!gitPatchOutputUsable(diff.code, diff.stdout) && tracked.code !== 0) {
      diff = await runGitDiffPatch(projectPath, ['--no-color', '-U3', '--no-index', '/dev/null', filePath], sshHost)
    }
    if (!gitPatchOutputUsable(diff.code, diff.stdout)) {
      const stub = entry?.summary.files.find((f) => f.path === filePath)
      return stub ? { ...stub, hunks: [] } : null
    }
    const parsed = parseUnifiedDiff(diff.stdout)
    const file = pickParsedDiffFile(parsed, filePath, filePath) ?? parsed[0]
    if (!file?.hunks.length) {
      const stub = entry?.summary.files.find((f) => f.path === filePath)
      return stub ? { ...stub, hunks: [] } : null
    }
    const merged = { ...file, path: filePath }
    if (entry) {
      entry.summary = {
        ...entry.summary,
        files: entry.summary.files.map((f) => (f.path === filePath ? { ...merged, hunks: merged.hunks } : f))
      }
    }
    return merged
  }

  async listCommits(projectPath: string, limit: number, sshHost?: string | null, force = false): Promise<CommitInfo[]> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (!force && entry?.commits) return entry.commits

    const summary = entry?.summary ?? (await this.refreshChanges(projectPath, sshHost))
    if (!summary.isRepo) return []
    const head = entry?.hasHead ?? (await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    if (!head) return []

    const res = await runGit(
      projectPath,
      ['log', `-n${limit}`, '--date=relative', '--pretty=format:%H%x1f%an%x1f%ad%x1f%s'],
      sshHost
    )
    if (res.code !== 0 || !res.stdout.trim()) return []
    const commits = res.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, author, date, message] = line.split('\x1f')
        return { hash, author, date, message }
      })
    if (entry) entry.commits = commits
    return commits
  }

  async listWorktrees(projectPath: string, sshHost?: string | null, force = false): Promise<WorktreeInfo[]> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (!force && entry?.worktrees) return entry.worktrees

    const summary = entry?.summary ?? (await this.refreshChanges(projectPath, sshHost))
    if (!summary.isRepo) return []

    const res = await runGit(projectPath, ['worktree', 'list', '--porcelain'], sshHost)
    if (res.code !== 0) return []
    const worktrees: WorktreeInfo[] = []
    let current: Partial<WorktreeInfo> | null = null
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current?.path) worktrees.push(current as WorktreeInfo)
        current = { path: line.slice('worktree '.length), branch: '', head: '', isMain: worktrees.length === 0 && !current }
      } else if (line.startsWith('HEAD ')) {
        if (current) current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        if (current) current.branch = line.slice('branch '.length).replace('refs/heads/', '')
      }
    }
    if (current?.path) worktrees.push(current as WorktreeInfo)
    const list = worktrees.map((w, idx) => ({ ...w, isMain: idx === 0 }))
    if (entry) entry.worktrees = list
    return list
  }

  onMutatingGitOp(projectPath: string, sshHost?: string | null): void {
    this.invalidate(projectPath, sshHost)
  }

  private async repoHasHead(projectPath: string, sshHost?: string | null): Promise<boolean> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (entry != null) return entry.hasHead
    return (await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  }

  /** Working tree vs HEAD (or empty tree) — for Diff › Expand file. */
  async loadWorkingTreeFilePair(
    projectPath: string,
    filePath: string,
    status: DiffFileStatus,
    sshHost?: string | null
  ): Promise<DiffFileContentPair | null> {
    let original = ''
    if (status !== 'added') {
      const hasHead = await this.repoHasHead(projectPath, sshHost)
      const ref = hasHead ? 'HEAD' : EMPTY_TREE
      const res = await runGit(projectPath, ['show', `${ref}:${filePath}`], sshHost)
      if (res.code === 0) original = res.stdout
    }

    let modified = ''
    if (status !== 'deleted') {
      const root = await resolveGitRepoRoot(projectPath, sshHost)
      const abs = join(root, filePath)
      try {
        const read = await readFileForPreview(abs, sshHost)
        if (read.kind !== 'text' && read.kind !== 'html') return null
        modified = read.content
      } catch {
        modified = ''
      }
    }

    return { original, modified }
  }

  /** Parent commit vs commit — for Diff › Commits › Expand file. */
  async loadCommitFilePair(
    projectPath: string,
    commit: string,
    filePath: string,
    status: DiffFileStatus,
    sshHost?: string | null
  ): Promise<DiffFileContentPair | null> {
    const gitPath = numstatPathForGit(filePath)
    let original = ''
    const parent = await runGit(projectPath, ['show', `${commit}^:${gitPath}`], sshHost)
    if (parent.code === 0) original = parent.stdout

    let modified = ''
    if (status !== 'deleted') {
      const atCommit = await runGit(projectPath, ['show', `${commit}:${gitPath}`], sshHost)
      if (atCommit.code === 0) modified = atCommit.stdout
      else return null
    }

    if (status === 'added' && !modified) return null
    if (original.includes('\0') || modified.includes('\0')) return null
    return { original, modified }
  }
}

export const gitRepositories = new GitRepositoryManager()

export function onWorkingTreeUpdated(listener: WorkingTreeUpdateListener): () => void {
  return gitRepositories.onWorkingTreeUpdated(listener)
}

/** Fast repo probe for session open — branch only, no numstat/ls-files scan. */
export async function probeGitRepo(
  projectPath: string,
  sshHost?: string | null
): Promise<DiffSummary> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, files: [] }
  }
  const branchRes = await runGitAtRepoRoot(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], sshHost)
  const branchRaw = branchRes.stdout.trim()
  const branch = branchRaw === 'HEAD' || !branchRaw ? null : branchRaw
  return { isRepo: true, branch, files: [] }
}

/** Working-tree snapshot with hunks hydrated (used at session open). */
export async function getDiffSummaryWithHunks(
  projectPath: string,
  sshHost?: string | null,
  force = false
): Promise<DiffSummary> {
  const summary = await gitRepositories.refreshChanges(projectPath, sshHost, force)
  if (!summary.isRepo || summary.files.length === 0) return summary
  return gitRepositories.hydrateWorkingTreeHunks(projectPath, sshHost, summary)
}

/** Back-compat: changes snapshot (file list, empty hunks until gitFileDiff). */
export async function getDiffSummary(projectPath: string, sshHost?: string | null, force = false): Promise<DiffSummary> {
  return gitRepositories.refreshChanges(projectPath, sshHost, force)
}

export async function getFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
  return gitRepositories.loadFileDiff(projectPath, filePath, sshHost)
}

export async function getCommitDiff(projectPath: string, commit: string, sshHost?: string | null): Promise<DiffSummary> {
  return gitRepositories.loadCommitDiff(projectPath, commit, sshHost)
}

export async function getCommitPanelOpen(
  projectPath: string,
  commit: string,
  sshHost?: string | null
): Promise<DiffSummary> {
  return gitRepositories.loadCommitPanelOpen(projectPath, commit, sshHost)
}

export async function getCommitFileDiff(
  projectPath: string,
  commit: string,
  filePath: string,
  sshHost?: string | null
): Promise<DiffFileChange | null> {
  return gitRepositories.loadCommitFileDiff(projectPath, commit, filePath, sshHost)
}

export async function getWorkingTreeFilePair(
  projectPath: string,
  filePath: string,
  status: DiffFileStatus,
  sshHost?: string | null
): Promise<DiffFileContentPair | null> {
  return gitRepositories.loadWorkingTreeFilePair(projectPath, filePath, status, sshHost)
}

export async function getCommitFilePair(
  projectPath: string,
  commit: string,
  filePath: string,
  status: DiffFileStatus,
  sshHost?: string | null
): Promise<DiffFileContentPair | null> {
  return gitRepositories.loadCommitFilePair(projectPath, commit, filePath, status, sshHost)
}

export async function listCommits(
  projectPath: string,
  limit = 50,
  sshHost?: string | null,
  force = false
): Promise<CommitInfo[]> {
  return gitRepositories.listCommits(projectPath, limit, sshHost, force)
}

export async function listWorktrees(projectPath: string, sshHost?: string | null, force = false): Promise<WorktreeInfo[]> {
  return gitRepositories.listWorktrees(projectPath, sshHost, force)
}

export async function addWorktree(projectPath: string, worktreePath: string, branch: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['worktree', 'add', '-b', branch, worktreePath], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree add failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export async function removeWorktree(projectPath: string, worktreePath: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['worktree', 'remove', worktreePath, '--force'], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree remove failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export async function mergeWorktreeBranch(projectPath: string, branch: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['merge', '--no-edit', branch], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git merge failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export function invalidateGitRepository(projectPath: string, sshHost?: string | null): void {
  gitRepositories.invalidate(projectPath, sshHost)
}

export async function warmRemoteGitHost(sshHost: string): Promise<void> {
  await gitRepositories.warmRemote(sshHost)
}

/** Current branch for composer context bar (null if not a repo or detached). */
export async function getGitBranch(projectPath: string, sshHost?: string | null): Promise<string | null> {
  const verify = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (verify.code !== 0 || verify.stdout.trim() !== 'true') return null
  const r = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], sshHost)
  if (r.code !== 0) return null
  const name = r.stdout.trim()
  if (!name || name === 'HEAD') return null
  return name
}

/** Current HEAD hash, or null if not a repo / no commits. */
export async function resolveHead(projectPath: string, sshHost?: string | null): Promise<string | null> {
  const verify = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (verify.code !== 0 || verify.stdout.trim() !== 'true') return null
  const r = await runGit(projectPath, ['rev-parse', 'HEAD'], sshHost)
  if (r.code !== 0) return null
  const hash = r.stdout.trim()
  return hash || null
}

/** Diff for session cap paths outside the workspace / git repo (baseline from first session edit). */
export async function getOutsideWorkspaceCapFileDiff(
  absPath: string,
  baseline: string,
  sshHost?: string | null
): Promise<{ file: DiffFileChange; pair: DiffFileContentPair } | null> {
  try {
    const read = await readFileForPreview(absPath, sshHost)
    if (read.kind !== 'text' && read.kind !== 'html') return null
    return getOutsideWorkspaceCapTextPairDiff(absPath, baseline, read.content, sshHost)
  } catch {
    return null
  }
}

/** Diff two in-memory text editions (plan review: previous vs latest transcript). */
export async function getOutsideWorkspaceCapTextPairDiff(
  displayPath: string,
  baseline: string,
  modified: string,
  sshHost?: string | null
): Promise<{ file: DiffFileChange; pair: DiffFileContentPair } | null> {
  const pair: DiffFileContentPair = { original: baseline, modified }

  if (sshHost) {
    const stats = countPlanReviewDiffStats(baseline, modified)
    const file: DiffFileChange = {
      path: displayPath,
      status: baseline.length === 0 ? 'added' : 'modified',
      additions: stats.additions,
      deletions: stats.deletions,
      hunks: []
    }
    return { file, pair }
  }

  const dir = await mkdtemp(join(tmpdir(), 'atelier-outside-diff-'))
  const baseFile = join(dir, 'baseline')
  const modifiedFile = join(dir, 'modified')
  try {
    await writeFile(baseFile, baseline, 'utf8')
    await writeFile(modifiedFile, modified, 'utf8')
    const patch = await runGit(
      dir,
      [
        ...GIT_PATCH_CONFIG_ARGS,
        'diff',
        ...GIT_NO_EXTERNAL_DIFF,
        '--no-color',
        '-U3',
        '--no-index',
        baseFile,
        modifiedFile
      ],
      sshHost
    )

    let file: DiffFileChange
    if (gitPatchOutputUsable(patch.code, patch.stdout)) {
      const parsed = parseUnifiedDiff(patch.stdout)[0]
      file = parsed ?? {
        path: displayPath,
        status: baseline.length === 0 ? 'added' : 'modified',
        additions: 0,
        deletions: 0,
        hunks: []
      }
    } else {
      file = {
        path: displayPath,
        status: baseline.length === 0 ? 'added' : 'modified',
        additions: 0,
        deletions: 0,
        hunks: []
      }
    }
    file.path = displayPath
    const stats = countPlanReviewDiffStats(baseline, modified)
    file.additions = stats.additions
    file.deletions = stats.deletions
    return { file, pair }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export type WorkingTreeNumstat = { additions: number; deletions: number }

/** Batched working-tree + staged numstat for all paths vs HEAD (2 git calls per repo root). */
export async function getWorkingTreeNumstatMap(
  projectPath: string,
  sshHost?: string | null
): Promise<Map<string, WorkingTreeNumstat>> {
  const map = new Map<string, WorkingTreeNumstat>()
  const hasHead =
    (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  const target = hasHead ? 'HEAD' : EMPTY_TREE
  for (const args of [
    ['diff', '--no-color', '--numstat', target],
    ['diff', '--no-color', '--numstat', '--cached']
  ]) {
    const r = await runGitAtRepoRoot(projectPath, args, sshHost)
    if (r.code !== 0) continue
    for (const f of parseNumstatLines(r.stdout.split('\n'))) {
      const prev = map.get(f.path) ?? { additions: 0, deletions: 0 }
      map.set(f.path, {
        additions: prev.additions + f.additions,
        deletions: prev.deletions + f.deletions
      })
    }
  }
  return map
}

/** Working tree + staged numstat for one path vs HEAD (or empty tree when no HEAD). */
export async function getPathWorkingTreeNumstat(
  projectPath: string,
  filePath: string,
  sshHost?: string | null
): Promise<{ additions: number; deletions: number } | null> {
  if (isAbsolute(filePath)) return null

  const hasHead = (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  const target = hasHead ? 'HEAD' : EMPTY_TREE
  let additions = 0
  let deletions = 0
  for (const args of [
    ['diff', '--no-color', '--numstat', target, '--', filePath],
    ['diff', '--no-color', '--numstat', '--cached', '--', filePath]
  ]) {
    const r = await runGitAtRepoRoot(projectPath, args, sshHost)
    if (r.code !== 0) continue
    for (const f of parseNumstatLines(r.stdout.split('\n'))) {
      additions += f.additions
      deletions += f.deletions
    }
  }
  if (additions === 0 && deletions === 0) {
    const repoRoot = await resolveGitRepoRoot(projectPath, sshHost)
    const absFile = join(resolve(repoRoot), filePath)
    let onDisk = false
    try {
      await access(absFile)
      onDisk = true
    } catch {
      /* file not present at workspace-relative path */
    }
    const untracked = await runGitAtRepoRoot(
      projectPath,
      ['ls-files', '--others', '--exclude-standard', '--', filePath],
      sshHost
    )
    const listed = untracked.code === 0 && untracked.stdout.trim().length > 0
    // Plans live under `.claude/plans/` which is often gitignored — still show cap stats when the file exists on disk.
    if (onDisk || listed) {
      const diffPath = onDisk ? absFile : filePath
      const diff = await runGitAtRepoRoot(
        projectPath,
        [
          '-c',
          'diff.external=',
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-color',
          '--numstat',
          '--no-index',
          '/dev/null',
          diffPath
        ],
        sshHost
      )
      if (diff.code <= 1 && diff.stdout.trim()) {
        for (const f of parseNumstatLines(diff.stdout.split('\n'))) {
          additions += f.additions
          deletions += f.deletions
        }
      }
    }
  }
  if (additions === 0 && deletions === 0) return null
  return { additions, deletions }
}

export async function listCommitsInRange(
  projectPath: string,
  oldHead: string,
  newHead: string,
  sshHost?: string | null
): Promise<Array<{ hash: string; subject: string; committedAt: string }>> {
  const r = await runGit(
    projectPath,
    ['log', '--format=%H%x09%s%x09%ct', `${oldHead}..${newHead}`],
    sshHost
  )
  if (r.code !== 0) return []
  const out: Array<{ hash: string; subject: string; committedAt: string }> = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    const [hash, subject, ct] = line.split('\t')
    if (!hash || !subject) continue
    const sec = parseInt(ct ?? '0', 10)
    out.push({
      hash,
      subject,
      committedAt: Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : new Date().toISOString()
    })
  }
  return out
}

export async function listCommitChangedPaths(
  projectPath: string,
  commit: string,
  sshHost?: string | null
): Promise<string[]> {
  const r = await runGit(projectPath, ['show', '--name-only', '--pretty=format:', commit], sshHost)
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
}

export async function latestReflogSubject(projectPath: string, sshHost?: string | null): Promise<string> {
  const r = await runGit(projectPath, ['reflog', '-1', '--format=%gs'], sshHost)
  return r.stdout.trim()
}
