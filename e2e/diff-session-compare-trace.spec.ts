import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { seedSkipOnboarding } from './e2e-config'

const SESSIONS = {
  fixRay: { id: 'a35b2ba0-f738-4ce1-8c6e-500acad8be2c', name: 'Fix ray init' },
  aiConf: { id: 'c38421a4-1ba9-42cf-94e4-6e298eae8d23', name: 'AI conformance instruction' },
  spark: { id: 'aad40140-ec8f-48d4-a6f1-e92f10723138', name: 'spark' }
} as const
const PROD_USER_DATA = join(process.env.HOME!, 'Library/Application Support/Atelier')
const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactDir = join(__dirname, '..', 'e2e-artifacts')

function copyProdUserData(dest: string): void {
  mkdirSync(join(dest, 'data'), { recursive: true })
  execSync(
    `sqlite3 "${join(PROD_USER_DATA, 'data/atelier.sqlite')}" ".backup '${join(dest, 'data/atelier.sqlite')}'"`
  )
  const cfgSrc = join(PROD_USER_DATA, 'data/config.json')
  if (existsSync(cfgSrc)) {
    cpSync(cfgSrc, join(dest, 'data/config.json'), { force: true })
  }
}

type UiSnapshot = {
  atMs: number
  sessionIdAttr: string | null
  loading: boolean
  panel: boolean
  refreshing: boolean
  fileRows: number
  diag: Record<string, unknown> | null
}

async function snapshotDiffUi(page: Page): Promise<UiSnapshot> {
  return page.evaluate(async () => {
    const activeRow = document.querySelector('[data-testid="session-row"][data-active="true"]')
    const sessionIdAttr = activeRow?.getAttribute('data-session-id') ?? null
    const loading = Boolean(document.querySelector('.empty-main')?.textContent?.includes('Loading diff'))
    const panel = Boolean(document.querySelector('[data-testid="diff-panel-active"]'))
    const refreshing = Boolean(document.querySelector('[data-testid="diff-refreshing"]'))
    const fileRows = document.querySelectorAll('[data-testid="diff-file-row"]').length
    const diag = sessionIdAttr
      ? ((await window.atelier.getSessionWorkspaceRefreshDiagnostics(sessionIdAttr)) as Record<
          string,
          unknown
        >)
      : null
    return { atMs: Date.now(), sessionIdAttr, loading, panel, refreshing, fileRows, diag }
  })
}

async function activateSession(page: Page, sessionId: string): Promise<{ stepMs: Record<string, number> }> {
  const stepMs: Record<string, number> = {}
  let t = Date.now()
  await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
  stepMs.clickRow = Date.now() - t
  t = Date.now()
  await page.getByTestId('tab-chat').click()
  stepMs.clickChat = Date.now() - t
  return { stepMs }
}

async function openDiffWithSnapshots(
  page: Page,
  sessionId: string,
  label: string
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const activate = await activateSession(page, sessionId)
  let t = Date.now()
  await page.getByTestId('tab-diff').click()
  const clickDiffMs = Date.now() - t

  const snapshots: UiSnapshot[] = []
  snapshots.push(await snapshotDiffUi(page))
  await page.waitForTimeout(5000)
  snapshots.push(await snapshotDiffUi(page))
  await page.waitForTimeout(10000)
  snapshots.push(await snapshotDiffUi(page))

  return {
    label,
    sessionId,
    totalMs: Date.now() - startedAt,
    activate,
    clickDiffMs,
    snapshots
  }
}

function parseTraceLines(logPath: string): unknown[] {
  const raw = readFileSync(logPath, 'utf8').trim()
  if (!raw) return []
  const traces: unknown[] = []
  for (const line of raw.split('\n')) {
    if (
      !line.includes('workspace:refresh:trace') &&
      !line.includes('diff:panel:trace') &&
      !line.includes('panel:git:diff:trace')
    ) {
      continue
    }
    try {
      traces.push(JSON.parse(line))
    } catch {
      // skip malformed
    }
  }
  return traces
}

function tracesForSession(traces: unknown[], sessionId: string): unknown[] {
  return traces.filter((row) => {
    const o = row as { sessionId?: string; panelScopeKey?: string; projectPath?: string }
    if (o.sessionId === sessionId) return true
    if (typeof o.panelScopeKey === 'string' && o.panelScopeKey.startsWith(sessionId)) return true
    if (typeof o.projectPath === 'string' && o.projectPath.includes(sessionId)) return true
    return false
  })
}

test('capture diff-session compare traces (fixed poll mode)', async () => {
  test.setTimeout(300_000)
  await runDiffSessionCompareTrace({ legacyPoll: false })
})

test('capture diff-session compare traces (legacy poll mode)', async () => {
  test.setTimeout(300_000)
  await runDiffSessionCompareTrace({ legacyPoll: true })
})

async function runDiffSessionCompareTrace(opts: { legacyPoll: boolean }): Promise<void> {
  const artifactPath = join(
    artifactDir,
    opts.legacyPoll ? 'diff-session-compare-trace-legacy.json' : 'diff-session-compare-trace-fixed.json'
  )
  mkdirSync(artifactDir, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-diff-trace-'))
  copyProdUserData(userDataDir)
  seedSkipOnboarding(userDataDir)
  const logPath = join(userDataDir, 'logs', 'main.log')

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ...(opts.legacyPoll ? { ATELIER_DIAGNOSTIC_LEGACY_POLL: '1' } : {})
    }
  })
  const page = await app.firstWindow()
  try {
    await expect(page.getByTestId('session-list')).toBeVisible({ timeout: 60_000 })

    const warmup: Record<string, unknown> = {}
    for (const [key, s] of Object.entries(SESSIONS)) {
      const t0 = Date.now()
      await activateSession(page, s.id)
      warmup[key] = { sessionId: s.id, activateMs: Date.now() - t0 }
    }

    // Let all three 15s devpod polls fire at least once while sessions stay open.
    await page.waitForTimeout(20_000)

    const fixRay = await openDiffWithSnapshots(page, SESSIONS.fixRay.id, SESSIONS.fixRay.name)
    await page.getByTestId('tab-chat').click()
    const aiConf = await openDiffWithSnapshots(page, SESSIONS.aiConf.id, SESSIONS.aiConf.name)

    await page.waitForTimeout(5000)
    const allTraces = parseTraceLines(logPath)
    const report = {
      mode: opts.legacyPoll ? 'ATELIER_DIAGNOSTIC_LEGACY_POLL=1' : 'fixed (default poll)',
      userDataDir,
      warmup,
      sessions: { fixRay, aiConf },
      traces: {
        fixRay: tracesForSession(allTraces, SESSIONS.fixRay.id),
        aiConf: tracesForSession(allTraces, SESSIONS.aiConf.id),
        spark: tracesForSession(allTraces, SESSIONS.spark.id),
        all: allTraces
      }
    }
    writeFileSync(artifactPath, JSON.stringify(report, null, 2))
    cpSync(
      logPath,
      join(artifactDir, opts.legacyPoll ? 'diff-session-compare-main-legacy.log' : 'diff-session-compare-main-fixed.log')
    )
    console.log(`Wrote ${artifactPath}`)
    console.log(`fixRay traces: ${report.traces.fixRay.length}, aiConf: ${report.traces.aiConf.length}`)
  } finally {
    await app.close()
  }
}
