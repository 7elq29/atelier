/**
 * e2e probe (fix/diff-refresh-round-trips): measures the git round trips a cap rebuild spends
 * resolving paths on a real remote workspace.
 *
 * `buildSessionChangesCap` and `mergeHintPathsIntoDiffSummary` call `resolveCapGitContext` ~8
 * times per session-touched path across their two serial loops. Each call used to issue an
 * uncached `git rev-parse --show-toplevel`, so a devpod refresh cost ~8 SSH round trips per path
 * and blew past REFRESH_WORKSPACE_TIMEOUT_MS, leaving "Refreshing diff…" on screen.
 *
 * Arm A clears the memo before every call to reproduce the old behavior; arm B leaves it warm.
 * Both arms make the same number of `resolveCapGitContext` calls, so the delta is purely caching.
 *
 * Run via: npm run build && node dist/e2e/run-cap-context-probe.js
 *   ATELIER_PROBE_HOST=<ssh host> ATELIER_PROBE_WORKSPACE=<remote path> to override the target.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { clearActualGitRepoRootCache, getGitInvocationCount, runGit } from '../main/panels/git-core'
import { resolveCapGitContext } from '../main/sessions/session-file-edits'

/** Matches the per-path `resolveCapGitContext` fan-out of one cap rebuild + hint merge. */
const CALLS_PER_PATH = 8

/**
 * Prefer real working-tree changes; fall back to tracked files under a pathspec so the probe runs
 * on a clean tree. The pathspec matters: this devpod's monorepo has ~1.6M tracked files and an
 * unscoped `ls-files` overruns runGit's 32MB buffer.
 */
async function remoteProbePaths(workspace: string, host: string): Promise<string[]> {
  const pathspec = process.env.ATELIER_PROBE_PATHSPEC ?? '.'
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--', pathspec]
  ]) {
    const res = await runGit(workspace, ['-C', workspace, ...args], host)
    if (res.code !== 0) throw new Error(`git ${args[0]} failed on ${host}: ${res.stderr.trim()}`)
    const paths = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    if (paths.length > 0) return paths
  }
  return []
}

async function measure(
  label: string,
  paths: string[],
  workspace: string,
  host: string,
  clearBetweenCalls: boolean
): Promise<{ label: string; gitCalls: number; ms: number; resolved: number }> {
  clearActualGitRepoRootCache(host)
  const gitCallsAt = getGitInvocationCount()
  const startedAt = Date.now()
  let resolved = 0

  for (const p of paths) {
    for (let i = 0; i < CALLS_PER_PATH; i += 1) {
      if (clearBetweenCalls) clearActualGitRepoRootCache(host)
      if (await resolveCapGitContext(p, workspace, host)) resolved += 1
    }
  }

  const out = {
    label,
    gitCalls: getGitInvocationCount() - gitCallsAt,
    ms: Date.now() - startedAt,
    resolved
  }
  console.log(
    `[probe] ${label.padEnd(22)} gitCalls=${String(out.gitCalls).padStart(4)}  ` +
      `${String(out.ms).padStart(6)}ms  resolved=${out.resolved}/${paths.length * CALLS_PER_PATH}`
  )
  return out
}

async function main(): Promise<void> {
  const host = process.env.ATELIER_PROBE_HOST ?? 'qingqin-go.devpod-us-or'
  const workspace =
    process.env.ATELIER_PROBE_WORKSPACE ??
    '/home/user/.atelier/worktrees/c38421a4-1ba9-42cf-94e4-6e298eae8d23'

  console.log(`[probe] host=${host}`)
  console.log(`[probe] workspace=${workspace}`)

  const paths = (await remoteProbePaths(workspace, host)).slice(0, 17)
  if (paths.length === 0) throw new Error('no paths on the remote workspace to probe')
  console.log(`[probe] probing ${paths.length} paths x ${CALLS_PER_PATH} resolveCapGitContext calls`)

  const before = await measure('uncached (old)', paths, workspace, host, true)
  const after = await measure('memoized (fixed)', paths, workspace, host, false)

  const speedup = before.ms / Math.max(after.ms, 1)
  console.log(
    `[probe] round trips ${before.gitCalls} -> ${after.gitCalls}, ` +
      `wall ${before.ms}ms -> ${after.ms}ms (${speedup.toFixed(1)}x)`
  )

  const artifactsDir = path.resolve(__dirname, '..', '..', 'e2e-artifacts')
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    path.join(artifactsDir, 'diff-refresh-round-trips.json'),
    JSON.stringify({ host, workspace, pathCount: paths.length, before, after }, null, 2)
  )

  if (after.gitCalls >= before.gitCalls) {
    throw new Error(`memo did not reduce round trips: ${before.gitCalls} -> ${after.gitCalls}`)
  }
  console.log('[probe] PASS')
}

void main().catch((err) => {
  console.error('[probe] FAILED', err)
  process.exit(1)
})
