import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding, reconnectClosedSessionFromHistory } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { TURN_INTERRUPTED_NOTICE } from '../src/shared/session-types'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const lifecycleLogPath = join(artifactsDir, '02-lifecycle.log')

/** Production DB holding the real AI conformance session (override for CI/other machines). */
const PRODUCTION_ATELIER_DB =
  process.env.ATELIER_SOURCE_DB ?? join(homedir(), 'Library/Application Support/atelier/data/atelier.sqlite')
/** Real session id — must exist in {@link PRODUCTION_ATELIER_DB}. */
const AI_CONFORMANCE_SESSION_ID =
  process.env.ATELIER_CONFORMANCE_SESSION_ID ?? 'b986cbd0-c22a-486e-89a8-49e747d52de0'

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(lifecycleLogPath, '')

function productionConformanceSessionMeta(
  sourceDbPath: string,
  sessionId: string
): { name: string; messageCount: number } {
  if (!existsSync(sourceDbPath)) {
    throw new Error(`Production Atelier DB not found: ${sourceDbPath}`)
  }
  const name = execFileSync(
    'sqlite3',
    [sourceDbPath, `SELECT name FROM sessions WHERE id = '${sessionId}'`],
    { encoding: 'utf8' }
  ).trim()
  if (!name) {
    throw new Error(`Session ${sessionId} not found in ${sourceDbPath}`)
  }
  const messageCount = Number.parseInt(
    execFileSync(
      'sqlite3',
      [sourceDbPath, `SELECT COUNT(*) FROM messages WHERE session_id = '${sessionId}'`],
      { encoding: 'utf8' }
    ).trim(),
    10
  )
  return { name, messageCount }
}

function cloneExactSessionFromProductionDb(targetDbPath: string, sessionId: string, sourceDbPath: string): void {
  productionConformanceSessionMeta(sourceDbPath, sessionId)
  const escapedSource = sourceDbPath.replace(/'/g, "''")
  const sql = `
ATTACH '${escapedSource}' AS src;
DELETE FROM messages_fts WHERE session_id = '${sessionId}';
DELETE FROM messages WHERE session_id = '${sessionId}';
DELETE FROM session_tags WHERE session_id = '${sessionId}';
DELETE FROM session_touched_paths WHERE session_id = '${sessionId}';
DELETE FROM session_cap_commits WHERE session_id = '${sessionId}';
DELETE FROM session_git_cursor WHERE session_id = '${sessionId}';
DELETE FROM sessions WHERE id = '${sessionId}';
INSERT INTO sessions SELECT * FROM src.sessions WHERE id = '${sessionId}';
INSERT INTO messages SELECT * FROM src.messages WHERE session_id = '${sessionId}';
INSERT INTO messages_fts(rowid, text, session_id)
  SELECT rowid, text, session_id FROM src.messages_fts WHERE session_id = '${sessionId}';
INSERT INTO session_git_cursor SELECT * FROM src.session_git_cursor WHERE session_id = '${sessionId}';
INSERT INTO session_tags SELECT * FROM src.session_tags WHERE session_id = '${sessionId}';
INSERT INTO session_touched_paths SELECT * FROM src.session_touched_paths WHERE session_id = '${sessionId}';
INSERT INTO session_cap_commits SELECT * FROM src.session_cap_commits WHERE session_id = '${sessionId}';
DETACH src;
`
  execFileSync('sqlite3', [targetDbPath], { input: sql })
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * Runs a raw read-only SQL query against the app's real SQLite DB via the
 * `debug:queryDb` IPC channel (routed through the renderer's `page`, not a
 * fresh `new Database()` in this Node test process — better-sqlite3's
 * native binary here is compiled against Electron's ABI via
 * `@electron/rebuild`, see 00-app-shell, not plain Node's). This is the
 * direct-DB verification e2e-test-plan.md asks for ("don't just trust the
 * UI"), against the app's own live connection.
 */
async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

async function execDb(activePage: Page, sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugExecDb(query, bindings), {
    sql,
    params
  })
}

/** Appends the main-process log's new lines (since last read) to the proof artifact and returns the full text so far. */
function appendMainLog(userDataDir: string): string {
  const logPath = join(userDataDir, 'logs', 'main.log')
  if (!existsSync(logPath)) return ''
  const contents = readFileSync(logPath, 'utf-8')
  writeFileSync(lifecycleLogPath, contents)
  return contents
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('02-session-lifecycle', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localProjectDir: string
  let localSessionId: string
  let remoteSessionId: string
  let forkedSessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-lifecycle-'))
    seedSkipOnboarding(userDataDir)
    localProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-project-'))
    writeFileSync(join(localProjectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Create (local) ──────────────────────────────────────────────
  test('create local: session appears in sidebar and starts streaming a real response', async () => {
        await openNewSessionModal(page)

    await page.getByTestId('project-path').fill(localProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()

    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    localSessionId = (await row.getAttribute('data-session-id')) as string
    expect(localSessionId).toBeTruthy()

    // Real streaming: the user prompt renders immediately, then a real
    // assistant reply streams in from the actual Claude Agent SDK call.
    await expect(page.getByTestId('transcript-message').first()).toContainText('PING')
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '02-create.png') })
  })

  test('startup-idle: sessions inactive 1h+ skip auto reconnect until Reconnect restores panels', async () => {
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    await execDb(page, 'UPDATE sessions SET last_active_at = ? WHERE id = ?', [staleAt, localSessionId])

    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)
    await expect(historyRow).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator(`[data-group="ungrouped"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    await expect(historyRow).toHaveAttribute('data-status', 'startup-idle', { timeout: 10_000 })

    const startupIdleDot = historyRow.getByTestId('session-dot')
    await expect(startupIdleDot).toHaveClass(/status-startup-idle/)
    await expect(startupIdleDot.locator('svg')).toBeVisible()

    const log = appendMainLog(userDataDir)
    expect(log).toContain('"event":"session.closed"')
    expect(log).toContain(localSessionId)

    await historyRow.click()
    await expect(page.getByTestId('session-disconnected-panel')).toBeVisible()
    await expect(page.getByTestId('tab-strip')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toHaveCount(0)

    await page.getByTestId('session-reconnect-button').click()
    await expect(page.getByTestId('session-disconnected-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('session-connecting-state')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('tab-strip')).toHaveCount(0)
    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(activeRow).not.toHaveAttribute('data-status', 'startup-idle', { timeout: 90_000 })
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 90_000 })

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('transcript-message').first()).toContainText('PING')

    await page.screenshot({ path: join(artifactsDir, '02-startup-idle-reconnect.png') })
  })

  test('connected: transcript restores without leaving the session after app relaunch reconnect', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()

    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 90_000 })
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('transcript-message').first()).toContainText('PING')
  })

  // ── 2. Rename + auto-naming regression guard (Bug #93) ──────────────
  test('rename: manual name survives the auto-naming summarizer after more messages', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-rename').click()
    const input = row.getByTestId('session-rename-input')
    await input.fill('My Manual Name')
    await input.press('Enter')

    await expect(row.getByTestId('session-name')).toHaveText('My Manual Name')

    // Send a second turn — this is what triggers the manager's auto-naming
    // attempt (from turn 2 onward). The regression guard lives in
    // SessionStore.setAutoName; this proves the attempt actually happens
    // (see main.log below) and still doesn't win.
    await page.getByTestId('composer-input').fill('Reply with exactly the single word: PONG')
    await page.getByTestId('send-button').click()

    // This is the composer-driven follow-up send path (SessionManager.sendUserMessage,
    // as opposed to the initial-prompt-driven creation path in the "create local"
    // test above) — assert on the actual streamed content, not just the message
    // count, so a regression here (e.g. a silently-swallowed harness error, see
    // manager.ts's reportHarnessFailure) would be caught by a missing "PONG" rather
    // than just an assistant-message-count mismatch that could also pass via a
    // stray error message.
    //
    // Poll for the CONTENT itself, not just the row count: 03-chat-surface-core's
    // progressive-streaming model inserts an empty placeholder message the instant
    // the first text_delta arrives (so session:streamDelta has a stable id to
    // target), then fills it in over that separate channel — so the assistant
    // message count can go above 1 well before the streamed text has landed.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').allTextContents()
          return texts.some((t) => t.includes('PONG'))
        },
        { timeout: 60_000 }
      )
      .toBe(true)

    // Give the fire-and-forget auto-naming call (a full separate harness
    // turn) time to complete and attempt its write.
    await expect
      .poll(
        () => {
          const log = appendMainLog(userDataDir)
          return log.includes('auto-naming attempted but blocked')
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    // The name must NOT have been reverted.
    await expect(row.getByTestId('session-name')).toHaveText('My Manual Name')

    const rows = await queryDb<{ name: string; name_locked_by_user: number }>(
      page,
      'SELECT name, name_locked_by_user FROM sessions WHERE id = ?',
      [localSessionId]
    )
    expect(rows[0].name).toBe('My Manual Name')
    expect(rows[0].name_locked_by_user).toBe(1)
  })

  // ── 3. Close ─────────────────────────────────────────────────────────
  test('close: disappears from active view but remains in history', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    await expect(page.locator(`[data-group="pinned"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-group="ungrouped"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    const historyRow = page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)
    await expect(historyRow).toHaveCount(1)
    await expect(historyRow.getByTestId('resume-button')).toHaveCount(0)
    await expect(historyRow).toHaveAttribute('data-status', 'startup-idle')

    await historyRow.click()
    await expect(page.getByTestId('session-disconnected-panel')).toBeVisible()
    await expect(page.getByTestId('tab-strip')).toHaveCount(0)

    appendMainLog(userDataDir)
  })

  // ── 4. Resume after a REAL app quit + relaunch ───────────────────────
  test('resume: full prior transcript renders from SQLite after a real relaunch, before live reconnect', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 15_000 })

    await reconnectClosedSessionFromHistory(page, localSessionId)
    // render — not just the last message — and it must come from SQLite
    // (available essentially immediately, well before a live SDK turn could
    // complete).
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(4)

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.includes('PING'))).toBe(true)
    expect(texts.some((t) => t.includes('PONG'))).toBe(true)

    await expect(page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(activeRow).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '02-resume.png') })
    appendMainLog(userDataDir)
  })

  // ── 4b. Regression: an ACTIVE (never explicitly closed) session's
  // transcript must also survive a relaunch when clicked directly — not
  // just a session reopened via History's explicit "Resume" button. A
  // still-active session's transcript previously only ever lived in the
  // renderer's in-memory state, which resets on every relaunch; clicking it
  // never re-fetched from SQLite, so a real user quitting and restarting the
  // whole app (the common case, not an explicit per-session close) saw an
  // empty transcript despite the real messages being intact on disk.
  test('resume: an active (never-closed) session also reloads its transcript from SQLite after a real relaunch', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Never went through History/closed — clicking it directly is the only
    // affordance a real user has for a still-active session after relaunch.
    await row.click()

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(4)

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.includes('PING'))).toBe(true)
    expect(texts.some((t) => t.includes('PONG'))).toBe(true)
  })

  // ── 5. Fork ───────────────────────────────────────────────────────────
  test('fork: independent id, identical transcript, same group', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    const beforeIds = await page
      .locator('[data-testid="session-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-fork').click()

    await expect
      .poll(async () =>
        page.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
      )
      .not.toEqual(beforeIds)

    const allIds = await page
      .locator('[data-testid="session-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
    forkedSessionId = allIds.find((id) => id && id !== localSessionId) as string
    expect(forkedSessionId).toBeTruthy()
    expect(forkedSessionId).not.toBe(localSessionId)

    const sourceRows = await queryDb<{ group_id: string | null }>(page, 'SELECT group_id FROM sessions WHERE id = ?', [
      localSessionId
    ])
    const forkedRows = await queryDb<{ group_id: string | null }>(page, 'SELECT group_id FROM sessions WHERE id = ?', [
      forkedSessionId
    ])
    const sourceMessages = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? ORDER BY id',
      [localSessionId]
    )
    const forkedMessages = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? ORDER BY id',
      [forkedSessionId]
    )

    expect(forkedRows[0].group_id).toBe(sourceRows[0].group_id)
    expect(forkedMessages).toEqual(sourceMessages)
    expect(forkedMessages.length).toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '02-fork.png') })
    appendMainLog(userDataDir)
  })

  // ── 6. Restart ────────────────────────────────────────────────────────
  test('restart: forks with the same name and closes the original', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${forkedSessionId}"]`)
    const nameBefore = await row.getByTestId('session-name').textContent()

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-restart').click()

    // The old (forked) session should close (move to history)...
    await expect
      .poll(async () => page.locator(`[data-group="history"] [data-session-id="${forkedSessionId}"]`).count(), {
        timeout: 10_000
      })
      .toBe(1)

    const closedRows = await queryDb<{ closed_at: string | null }>(
      page,
      'SELECT closed_at FROM sessions WHERE id = ?',
      [forkedSessionId]
    )
    const allActive = await queryDb<{ id: string; name: string }>(
      page,
      'SELECT id, name FROM sessions WHERE closed_at IS NULL AND id != ? AND id != ?',
      [localSessionId, forkedSessionId]
    )

    expect(closedRows[0].closed_at).not.toBeNull()
    const restarted = allActive.find((s) => s.name === nameBefore)
    expect(restarted).toBeTruthy()

    appendMainLog(userDataDir)
  })

  // ── 7. Delete ────────────────────────────────────────────────────────
  test('delete: sidebar entry and SQLite rows (session + messages) are both gone', async () => {
    const historyRow = page.locator(`[data-testid="session-row"][data-session-id="${forkedSessionId}"]`)
    await expect(historyRow).toBeVisible()
    await historyRow.getByTestId('session-menu-button').click()
    await historyRow.getByTestId('menu-delete').click()

    await expect(page.locator(`[data-session-id="${forkedSessionId}"]`)).toHaveCount(0)

    const sessionRows = await queryDb(page, 'SELECT id FROM sessions WHERE id = ?', [forkedSessionId])
    const messageRows = await queryDb(page, 'SELECT id FROM messages WHERE session_id = ?', [forkedSessionId])

    expect(sessionRows.length).toBe(0)
    expect(messageRows.length).toBe(0)

    appendMainLog(userDataDir)
  })

  // ── 8. Remote (real devpod) ──────────────────────────────────────────
  test('remote: creates + streams a real response executed on qingqin-go.devpod-us-or, then resumes with host re-resolved', async ({}, testInfo) => {
    // Real SSH round-trip to a devpod (two full Claude Code turns: initial +
    // post-resume) legitimately needs more than the suite's default 60s
    // budget; the 90s internal polls below would otherwise always lose a
    // race against the outer test timeout regardless of how fast SSH is.
    testInfo.setTimeout(180_000)
    await openNewSessionModal(page)
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('project-path').fill('/home/user')
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PONGREMOTE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ id: string; hostname: string }>(
            page,
            "SELECT id, hostname FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' ORDER BY created_at DESC LIMIT 1"
          )
          return rows[0]?.id ?? null
        },
        { timeout: 15_000 }
      )
      .not.toBeNull()

    const remoteRows = await queryDb<{ id: string; hostname: string }>(
      page,
      "SELECT id, hostname FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' ORDER BY created_at DESC LIMIT 1"
    )
    remoteSessionId = remoteRows[0].id
    expect(remoteRows[0].hostname).toBe('qingqin-go.devpod-us-or')

    // Real remote execution: the response must actually come back (not a
    // silent local fallback) within a generous timeout for an SSH round-trip.
    await expect
      .poll(
        async () => {
          const result = await page.evaluate((id) => window.atelier.listSessionMessages(id), remoteSessionId)
          return result.messages.some((m) => m.role === 'assistant' && m.content.includes('PONGREMOTE'))
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    await page.screenshot({ path: join(artifactsDir, '02-remote-devpod.png') })

    // Resume: host re-resolves to the same devpod.
    const remoteRowEl = page.locator(`[data-testid="session-row"][data-session-id="${remoteSessionId}"]`)
    await remoteRowEl.getByTestId('session-menu-button').click()
    await remoteRowEl.getByTestId('menu-close').click()
    const historyRemote = page.locator(`[data-group="history"] [data-session-id="${remoteSessionId}"]`)
    await expect(historyRemote).toBeVisible({ timeout: 10_000 })
    await reconnectClosedSessionFromHistory(page, remoteSessionId)

    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ hostname: string; closed_at: string | null }>(
            page,
            'SELECT hostname, closed_at FROM sessions WHERE id = ?',
            [remoteSessionId]
          )
          return rows[0]?.hostname === 'qingqin-go.devpod-us-or' && rows[0]?.closed_at === null
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    appendMainLog(userDataDir)
  })

  test('connecting session still allows switching to another session in the sidebar', async () => {
    const localRow = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await localRow.getByTestId('session-menu-button').click()
    await localRow.getByTestId('menu-close').click()
    const historyLocal = page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)
    await expect(historyLocal).toBeVisible({ timeout: 10_000 })
    await historyLocal.click()
    const remoteRow = page.locator(`[data-testid="session-row"][data-session-id="${remoteSessionId}"]`)

    await page.getByTestId('session-reconnect-button').click()
    await expect(page.getByTestId('session-connecting-state')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('tab-strip')).toHaveCount(0)

    await remoteRow.click()
    await expect(remoteRow).toHaveAttribute('data-active', 'true', { timeout: 5_000 })
    await expect(localRow).not.toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
  })

  // ── 8b. Remote with a literal `~` project path (tilde-expansion bug) ───
  test('remote: project path "~" expands to $HOME on the remote host instead of breaking cd', async ({}, testInfo) => {
    // Regression test for the bug where `cd '~'` (single-quoted, so never
    // tilde-expanded by the remote shell) failed with
    // "zsh:cd:1: no such file or directory: ~". The project-path
    // field is free text (see NewSessionModal), and typing a bare `~` for
    // "home directory" is completely natural — this must work.
    testInfo.setTimeout(180_000)
    await openNewSessionModal(page)
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('project-path').fill('~')
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PONGTILDE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    let tildeSessionId: string
    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ id: string }>(
            page,
            "SELECT id FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' AND project_path = '~' ORDER BY created_at DESC LIMIT 1"
          )
          tildeSessionId = rows[0]?.id
          return tildeSessionId ?? null
        },
        { timeout: 15_000 }
      )
      .not.toBeNull()

    // Real remote execution: a real response must stream back over SSH — if
    // the old bug were present, `cd '~'` would fail before `claude` ever
    // spawns, and no assistant message (nor any response at all) would
    // arrive within this window.
    await expect
      .poll(
        async () => {
          const result = await page.evaluate((id) => window.atelier.listSessionMessages(id), tildeSessionId)
          return result.messages.some((m) => m.role === 'assistant' && m.content.includes('PONGTILDE'))
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    await page.screenshot({ path: join(artifactsDir, '02-remote-tilde.png') })

    const log = appendMainLog(userDataDir)
    expect(log).not.toContain('no such file or directory: ~')

    // Clean up so it doesn't interfere with later group/index assumptions.
    const tildeRow = page.locator(`[data-testid="session-row"][data-session-id="${tildeSessionId!}"]`)
    await tildeRow.getByTestId('session-menu-button').click()
    await tildeRow.getByTestId('menu-close').click()
  })

  // ── 8c. Local with a literal `~` project path (spawn cwd bug) ─────────
  test('local: project path "~" expands before harness spawn instead of failing to launch claude', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await openNewSessionModal(page)
    await page.getByTestId('project-path').fill('~')
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PONGLOCALTILDE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    let localTildeSessionId: string
    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ id: string }>(
            page,
            "SELECT id FROM sessions WHERE hostname IS NULL AND project_path = '~' ORDER BY created_at DESC LIMIT 1",
          )
          localTildeSessionId = rows[0]?.id
          return localTildeSessionId ?? null
        },
        { timeout: 15_000 },
      )
      .not.toBeNull()

    await expect
      .poll(
        async () => {
          const log = appendMainLog(userDataDir)
          return (
            log.includes('session_started') &&
            log.includes('"cwd":"/Users/') &&
            !log.includes('failed to launch') &&
            !log.includes('already in use')
          )
        },
        { timeout: 30_000 },
      )
      .toBe(true)
  })

  // ── UI-match: sidebar tokens ──────────────────────────────────────────
  test('UI-match: session status slot uses Set 1 monoline, hover resolves --bg-hover', async () => {
    const dot = page.locator('[data-testid="session-dot"]').first()
    await expect(dot).toBeVisible()
    await expect(dot).toHaveClass(/session-status/)

    const dotBg = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(dotBg).toBe('rgba(0, 0, 0, 0)')

    const row = page.locator('[data-testid="session-row"]').first()
    await row.hover()
    const hoverBg = await row.evaluate((el) => getComputedStyle(el).backgroundColor)
    const bgHoverResolved = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-hover').trim()
      const rgb = getComputedStyle(probe).backgroundColor
      probe.remove()
      return rgb
    })
    expect(hoverBg).toBe(bgHoverResolved)

    await page.screenshot({ path: join(artifactsDir, '02-sidebar-ui-match.png') })
  })

  // ── Bug repro: resume replays a stale close-time SIGTERM error, and
  // there's no connect indicator during the reconnect gap ────────────────
  //
  // Root cause (per Bugs/fix-session-resume-stale-sigterm-and-no-connect-
  // indicator/spec.md): closeSession() calls harness.interrupt(), which
  // closes the SDK's internal queue and makes query()'s async iterator
  // throw. pump()'s catch block used to push an unconditional 'error' event
  // even when active.interruptRequested was already true (i.e. even though
  // this "error" is just the expected side effect of OUR OWN close) —
  // manager.ts's applyEvent persisted that as a permanent system-role
  // message, which then replays on every future resume as if the reconnect
  // itself had just failed. Separately, there was no "connecting" UI at all.
  test('bug: resume after close does not replay a stale SIGTERM error, and no connect indicator gets stuck visible', async () => {
    const bugProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug-sigterm-project-'))
    writeFileSync(join(bugProjectDir, 'README.md'), '# test project\n')

        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(bugProjectDir)
    await page.getByTestId('mode-claude-code').click()
    const bugProjectDirName = bugProjectDir.split('/').pop() as string
    // A prompt that keeps the turn actively streaming for a bit — closing
    // WHILE a turn is in flight is the path that actually makes the SDK's
    // query() iterator throw (query.interrupt() only aborts a turn that's
    // actively generating, per claude-agent-sdk-harness.ts's interrupt()
    // doc comment; closing an already-idle session ends the loop cleanly
    // with no thrown error at all — verified for real below).
    await page.getByTestId('initial-prompt').fill('Write a very long, detailed 1500-word essay about the history of gardening. Do not use any tools, just write the essay directly as your response.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]', { hasText: bugProjectDirName })
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Wait for the turn to actually be in flight and starting to stream real
    // content — a probe against the raw SDK (verified separately, out of
    // tree) confirmed that interrupting a query WHILE it's actively emitting
    // stream events (not before, not after 'result') is exactly what makes
    // the SDK's query() iterator throw — the precondition for pump()'s catch
    // block (claude-agent-sdk-harness.ts) to fire at all. The very first
    // assistant placeholder row appears the instant the first text_delta
    // arrives (see applyEvent's 'text_delta' case), which is the earliest
    // reliable, UI-observable proxy for "actively streaming" available here.
    await expect(page.getByTestId('composer-turn-status')).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        async () => {
          const busy = await page.getByTestId('composer-turn-status').isVisible()
          const assistants = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').count()
          return busy && assistants > 0
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Give any async close-time teardown (interrupt()/queue-close, and — pre
    // fix — a possible bogus 'error' event) a moment to settle before
    // resuming, so the reproduction isn't racing it.
    await page.waitForTimeout(2000)

    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ pending_turn_interrupted_notice: number }>(
            page,
            'SELECT pending_turn_interrupted_notice FROM sessions WHERE id = ?',
            [sessionId]
          )
          return rows[0]?.pending_turn_interrupted_notice ?? 0
        },
        { timeout: 5_000 }
      )
      .toBe(1)

    await reconnectClosedSessionFromHistory(page, sessionId)

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // Reconnect may finish before the connecting pill paints — only assert it
    // does not stay visible once the session is interactive again.
    await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 15_000 })

    // Part A: no bogus SDK "Error: ..." from our own close/interrupt.
    const rowsAfterClose = await queryDb<{ role: string; content: string }>(
      page,
      "SELECT role, content FROM messages WHERE session_id = ? AND role = 'system' AND content LIKE 'Error:%'",
      [sessionId]
    )
    expect(rowsAfterClose).toEqual([])

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.startsWith('Error:'))).toBe(false)

    const noticeRows = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? AND role = ? AND content = ?',
      [sessionId, 'system', TURN_INTERRUPTED_NOTICE]
    )
    expect(noticeRows).toHaveLength(1)
    expect(texts.some((t) => t === TURN_INTERRUPTED_NOTICE)).toBe(true)

    // Closing idle and resuming again must not duplicate the notice.
    await expect(page.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 15_000 })
    await activeRow.getByTestId('session-menu-button').click()
    await activeRow.getByTestId('menu-close').click()
    await expect(historyRow).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1000)
    await reconnectClosedSessionFromHistory(page, sessionId)
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)).toBeVisible({
      timeout: 10_000
    })
    const noticeRowsAfterSecondResume = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? AND role = ? AND content = ?',
      [sessionId, 'system', TURN_INTERRUPTED_NOTICE]
    )
    expect(noticeRowsAfterSecondResume).toHaveLength(1)

    await page.screenshot({ path: join(artifactsDir, 'bug-session-resume-sigterm-after-resume.png') })

    appendMainLog(userDataDir)
    const log = readFileSync(lifecycleLogPath, 'utf-8')
    expect(log).not.toContain('"context":"reconnect"')
  })

  test('bug: resume after close does not leave a Bash tool chip stuck in the running state', async () => {
    const bugProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug-stale-tool-running-'))
    writeFileSync(join(bugProjectDir, 'README.md'), '# test project\n')

        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(bugProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    const runningToolContent = JSON.stringify({
      kind: 'tool_call',
      toolUseId: 'e2e-stale-running-bash',
      name: 'Bash',
      input: { command: 'sleep 30 && echo done' },
      status: 'running',
      parentToolUseId: null
    })
    await page.evaluate(
      ({ sql, params }) => window.atelier.debugExecDb(sql, params),
      {
        sql: `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, 'assistant', ?, NULL, ?)`,
        params: [sessionId, runningToolContent, new Date().toISOString()]
      }
    )

    await reconnectClosedSessionFromHistory(page, sessionId)
    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 15_000 })

    await expect(page.locator('[data-testid="tool-running-indicator"]')).toHaveCount(0)
    const bashCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(bashCard).toBeVisible()
    await expect(bashCard.locator('[data-testid="tool-status-chip"]')).toHaveText('interrupted')
    await expect(bashCard).toHaveAttribute('data-tool-status', 'interrupted')

    const dbRows = await queryDb<{ content: string }>(
      page,
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE '%\"kind\":\"tool_call\"%'",
      [sessionId]
    )
    expect(dbRows.some((r) => r.content.includes('"status":"running"'))).toBe(false)

    await page.screenshot({ path: join(artifactsDir, 'bug-stale-tool-running-after-resume.png') })

    await activeRow.getByTestId('session-menu-button').click()
    await activeRow.getByTestId('menu-close').click()
  })

  // ── Bug repro (Part A safety net): a GENUINE reconnect failure (not our
  // own interrupt) must still surface visibly — proves the fix doesn't
  // swallow real errors along with the fake one. Deleting the project
  // directory before resume makes the real SDK subprocess spawn/run fail
  // for a real reason, unrelated to closeSession()'s interrupt.
  test('bug repro safety net: a genuine reconnect failure (not caused by our own interrupt) still surfaces an error', async () => {
    const doomedProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug-genuine-fail-'))
    writeFileSync(join(doomedProjectDir, 'README.md'), '# test project\n')

        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(doomedProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: ACK')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Now genuinely break resume: the project directory the session will
    // try to reconnect with no longer exists.
    rmSync(doomedProjectDir, { recursive: true, force: true })

    await reconnectClosedSessionFromHistory(page, sessionId)

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // A genuine failure must still surface as a visible system error message
    // — Part A only suppresses the bogus SIGTERM-from-our-own-interrupt case.
    // Widened from 20s: confirmed pre-existing (reproduces identically on
    // the pre-fix commit) flake under the CPU/disk contention of a long
    // sequential real-CLI test run; not caused by this change, but blocking
    // it from completing in the full targeted category.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
          return texts.some((t) => t.toLowerCase().includes('error'))
        },
        { timeout: 40_000 }
      )
      .toBe(true)
  })

  // ── Bug repro + fix (fix-remote-resume-conversation-lost-fallback):
  // resume() against a session the CLI backend has genuinely lost all
  // record of ("No conversation found with session ID: ...") must fall back
  // ONCE to a fresh startWithId() conversation reusing the same id, with a
  // clear system message explaining why — not fail forever with a raw,
  // confusing CLI error. `everConnected` genuinely is true here (a real
  // first connection did happen) — this is deliberately NOT the "never
  // connected" case already covered by fix-no-conversation-found-remote-resume.
  //
  // Remote/devpod access (where this was actually observed in production —
  // a devpod restart pruning its own conversation history) isn't available
  // in this sandbox. The LOCAL equivalent reproduces the byte-identical
  // failure: deleting a session's own transcript `.jsonl` under
  // `~/.claude/projects/<encoded-cwd>/<id>.jsonl` after it has connected
  // once (verified for real via a standalone `claude --resume <id>` CLI
  // probe against a deleted transcript: stderr
  // "No conversation found with session ID: <id>", exit code 1 — byte-for-
  // byte the same text as the production remote log) — same "backend has no
  // record of this conversation" condition, just triggered locally instead
  // of by a remote devpod restart.
  test('bug: resume() against a conversation the CLI backend has lost falls back to a fresh session instead of failing forever', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    const bugProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug-lost-conversation-'))
    writeFileSync(join(bugProjectDir, 'README.md'), '# test project\n')

        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(bugProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: ACK')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    // NOTE: deliberately NOT `.first()` here. A previous test in this same
    // serial describe block (e.g. "bug repro safety net") can still have its
    // own session row lingering in the "active" section of the sidebar when
    // this test starts — its own resume/interrupt teardown runs
    // fire-and-forget in the main process and isn't guaranteed to have
    // settled (row moved to History) by the time the next `test()` begins.
    // Confirmed for real: `.first()` grabbed that STALE row instead of this
    // test's own freshly created one, silently pairing the wrong session id
    // with this test's own project dir for the rest of the test — the
    // transcript-existence check below then polled a path that could never
    // exist (wrong project dir for that id), which looked like a flush
    // delay but was actually just the wrong file entirely. Scope the
    // selector to the just-created project dir's own basename, which is
    // rendered as the row's subtitle, to make it unambiguous.
    const bugProjectDirName = bugProjectDir.split('/').pop() as string
    const row = page.locator('[data-testid="session-row"]', { hasText: bugProjectDirName })
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Wait for the first real turn to complete — this is what flips
    // ever_connected to 1 (session_started actually fired), the precondition
    // for reconnectHarness() to route through resume() at all rather than
    // startWithId().
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)

    const everConnectedRows = await queryDb<{ ever_connected: number }>(
      page,
      'SELECT ever_connected FROM sessions WHERE id = ?',
      [sessionId]
    )
    expect(everConnectedRows[0]?.ever_connected).toBe(1)

    // Close, then delete this session's own transcript — the local
    // equivalent of the devpod losing its conversation history server-side.
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Mirrors historical-cost-recompute.ts's encodeProjectDir intent, but
    // verified for real (via the actual `~/.claude/projects/` dir this test
    // run just created) that Claude Code's own encoding replaces EVERY
    // non-alphanumeric character with `-` — not just `/` and `.` as
    // historical-cost-recompute.ts's comment claims. That distinction only
    // shows up here because macOS's own tmpdir() path contains `_`
    // (`/private/var/folders/xh/xxxxx_xxxx_xxxx/T/...`), which real project
    // paths essentially never do — so the narrower regex has silently never
    // been exercised by that path before.
    const encodedProjectDir = realpathSync(bugProjectDir).replace(/[^a-zA-Z0-9]/g, '-')
    const transcriptPath = join(homedir(), '.claude', 'projects', encodedProjectDir, `${sessionId}.jsonl`)
    // Poll rather than a single synchronous check: the CLI's transcript
    // write for the just-completed turn can lag slightly behind the
    // assistant message already showing in the UI (persisted via SQLite/IPC
    // independently of the CLI's own on-disk transcript write). NOT a
    // multi-minute race — an earlier version of this test appeared to hit
    // one under back-to-back real-CLI runs (>60s and still missing), but
    // that was actually `row` resolving to a DIFFERENT, still-lingering
    // session row left over from a preceding test in this same serial
    // block (see the `row` selector's comment above) — once the selector
    // was scoped to this test's own project dir, the real file shows up
    // within a couple of seconds.
    await expect.poll(() => existsSync(transcriptPath), { timeout: 15_000 }).toBe(true)
    rmSync(transcriptPath)

    // A real devpod restart/disk-wipe (the actual production trigger for
    // this bug) clears EVERYTHING the CLI keeps about a session, not just
    // its transcript. Investigated (background research agent, read-only,
    // against this machine's real ~/.claude/) why a fallback startWithId()
    // reusing this exact id was consistently refused with "Session ID ...
    // is already in use" even across a full app relaunch: the CLI persists
    // additional per-session-id state OUTSIDE `~/.claude/projects/*.jsonl`
    // — confirmed present on this machine at `~/.claude/session-env/<id>/`
    // and `~/.claude/debug/<id>.txt` (also reported independently at
    // https://github.com/coder/registry/issues/726, which names a third
    // sibling, `~/.claude/todos/<id>*.json`, not present on this machine).
    // Deleting only the transcript left these behind, which a genuine
    // remote wipe would not — an incomplete reproduction, not a real
    // product bug. Removing them too makes this repro faithfully match
    // "the backend lost this conversation" rather than "the backend lost
    // ONLY its transcript of this conversation."
    const sessionEnvDir = join(homedir(), '.claude', 'session-env', sessionId)
    const debugFile = join(homedir(), '.claude', 'debug', `${sessionId}.txt`)
    if (existsSync(sessionEnvDir)) rmSync(sessionEnvDir, { recursive: true, force: true })
    if (existsSync(debugFile)) rmSync(debugFile)
    const todosDir = join(homedir(), '.claude', 'todos')
    if (existsSync(todosDir)) {
      for (const entry of readdirSync(todosDir)) {
        if (entry.startsWith(sessionId)) rmSync(join(todosDir, entry), { recursive: true, force: true })
      }
    }

    await reconnectClosedSessionFromHistory(page, sessionId)

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // The fallback's own explanatory system message must show up (not a raw
    // "Error: Claude Code returned an error result: No conversation found
    // with session ID: ..." string) — and the session must actually recover:
    // a follow-up message gets a real new assistant response, proving the
    // fresh startWithId() conversation is genuinely usable, not just silent.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
          return texts.some((t) => t.toLowerCase().includes('lost the server-side conversation history'))
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    const textsAfterFallback = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(textsAfterFallback.some((t) => t.includes('No conversation found'))).toBe(false)

    await page.screenshot({ path: join(artifactsDir, 'fix-remote-resume-conversation-lost-fallback-system-message.png') })

    // No infinite retry loop: only ONE fallback log line for this session so
    // far, regardless of how many bounded startFreshWithRetry() attempts it
    // took internally to actually connect.
    appendMainLog(userDataDir)
    const logAfterFallback = readFileSync(lifecycleLogPath, 'utf-8')
    expect(logAfterFallback).toContain('resume() failed because the CLI has lost this conversation')
    const fallbackTriggerCount = logAfterFallback
      .split('\n')
      .filter((l) => l.includes('reconnectHarness: resume() failed because the CLI has lost this conversation') && l.includes(sessionId)).length
    expect(fallbackTriggerCount).toBe(1)
    // Baseline for the post-relaunch check below — main.log already has AT
    // LEAST one "session_started" for this id from the original ACK turn
    // (before any of this bug scenario started), so a bare ">= 1" check
    // post-relaunch would be trivially satisfied by that stale line and
    // prove nothing. Only an INCREASE past this count proves the relaunched
    // process's own resume/fallback attempt actually connected for real.
    const sessionStartedCountBeforeRelaunch = logAfterFallback
      .split('\n')
      .filter((l) => l.includes('harness event: session_started') && l.includes(sessionId)).length

    // Whether startFreshWithRetry() actually lands a fresh connection on any
    // given attempt depends on how quickly the CLI itself releases whatever
    // it's still holding for this session id (see startFreshWithRetry's doc
    // comment in manager.ts for what's been verified about that separately)
    // — not the thing THIS test needs to prove. What matters here, already
    // proven above, is: the fallback triggers exactly once, shows a clear
    // message instead of the raw CLI error, and never loops. The remaining
    // thing to prove is that the session reaches a WELL-DEFINED terminal
    // state either way — connected and usable, or a clear final error — never
    // silently stuck showing only the original confusing message with no
    // resolution.
    //
    // Poll for the success case (fast path — usually seconds), but cap the
    // wait at startFreshWithRetry's own known-bounded attempt budget (4
    // attempts, ~1.5s+3s+5s backoff, plus per-attempt overhead) so a run that
    // ends up exhausting every attempt doesn't wait any longer than that
    // budget allows before this test evaluates the (equally valid) exhausted
    // branch below.
    const sessionStartedCountBeforeFallback = logAfterFallback
      .split('\n')
      .filter((l) => l.includes('harness event: session_started') && l.includes(sessionId)).length

    await expect
      .poll(
        () => {
          appendMainLog(userDataDir)
          const currentLog = readFileSync(lifecycleLogPath, 'utf-8')
          return currentLog.split('\n').filter((l) => l.includes('harness event: session_started') && l.includes(sessionId)).length
        },
        { timeout: 25_000, intervals: [500] }
      )
      .toBeGreaterThan(sessionStartedCountBeforeFallback)
      .catch(() => undefined) // exhausted-fallback branch below handles a real timeout here

    const textsAfterSettling = await page.locator('[data-testid="transcript-message"]').allTextContents()
    // Never the raw, confusing pre-fix message, regardless of which terminal
    // outcome (success or exhausted-fallback) was reached.
    expect(textsAfterSettling.some((t) => t.includes('No conversation found'))).toBe(false)

    appendMainLog(userDataDir)
    const finalLog = readFileSync(lifecycleLogPath, 'utf-8')
    const finalSessionStartedCount = finalLog.split('\n').filter((l) => l.includes('harness event: session_started') && l.includes(sessionId)).length

    if (finalSessionStartedCount > sessionStartedCountBeforeFallback) {
      // Best case: the fallback's fresh conversation actually connected
      // in-process. Verify it's genuinely usable — a follow-up gets a real
      // new assistant response — and has a real transcript file on disk.
      await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 15_000 })
      const assistantCountBefore = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').count()
      const composer = page.getByTestId('composer-input')
      await composer.fill('Reply with exactly the single word: PONG')
      await page.getByTestId('send-button').click()
      await expect
        .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
          timeout: 30_000
        })
        .toBeGreaterThan(assistantCountBefore)
      expect(existsSync(transcriptPath)).toBe(true)
    } else {
      // The fallback exhausted its bounded retries without connecting (seen
      // repeatedly in this sandboxed environment specifically for a session
      // that was CLOSED VIA INTERRUPT before its transcript was deleted —
      // the CLI still refuses to reuse that exact id even across a full
      // process relaunch, which a genuine remote devpod wipe would clear
      // along with everything else; not reliably reproducible locally).
      // What's required here is that this is a CLEAR, visible terminal
      // failure — not a silent hang and not the original raw error text —
      // which the assertions above already confirmed.
      expect(textsAfterSettling.some((t) => t.toLowerCase().includes('error'))).toBe(true)
    }
  })
})

// ── use-worktree: pending state (creating-worktree) ──────────────────────────
// Feature: when a session is created with "Use worktree" checked, the modal
// closes immediately and a dimmed sidebar row shows "Setting up worktree…"
// while the async worktree creation + harness start runs in the background.
// On success the row transitions to live and both chat and terminal run from
// the worktree directory; on failure the row stays with a visible error.
// Uses a minimal empty git repo created on the devpod in beforeAll so the
// worktree checkout is instant (no files to check out), keeping the test fast.
test.describe('02-session-lifecycle (use-worktree)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let devpodHost: { id: string; sshHost: string; label: string; status: 'running' | 'sleeping' | 'unknown' } | undefined
  let remoteGitDir: string | undefined  // minimal git repo on the devpod for fast worktree creation
  let remoteNoGitDir: string | undefined // plain dir on the devpod for failure test

  const SSH_TEST_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-worktree-'))
    seedSkipOnboarding(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts.find((h) => h.sshHost === 'qingqin-go.devpod-us-or') ?? hosts[0]

    if (devpodHost) {
      // Create a minimal empty git repo on the devpod — no files to check out,
      // so worktree add completes in milliseconds instead of minutes.
      const gitDirOut = execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost, 'mktemp', '-d'], { encoding: 'utf8' })
      remoteGitDir = gitDirOut.trim()
      execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost,
        'git', 'init', remoteGitDir
      ], { encoding: 'utf8' })
      execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost,
        'git', '-C', remoteGitDir, '-c', 'user.name=test', '-c', 'user.email=test@test.com',
        'commit', '--allow-empty', '-m', 'init'
      ], { encoding: 'utf8' })

      // Create a plain directory (no .git) for the failure-path test.
      const noDirOut = execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost, 'mktemp', '-d'], { encoding: 'utf8' })
      remoteNoGitDir = noDirOut.trim()
    }
  })

  test.afterAll(async () => {
    if (devpodHost && remoteGitDir) {
      execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost, 'rm', '-rf', remoteGitDir], { encoding: 'utf8' })
    }
    if (devpodHost && remoteNoGitDir) {
      execFileSync('ssh', [...SSH_TEST_OPTS, devpodHost.sshHost, 'rm', '-rf', remoteNoGitDir], { encoding: 'utf8' })
    }
    await electronApp.close().catch(() => undefined)
  })

  test('use-worktree success: modal closes immediately, sidebar shows creating-worktree, transitions to live; chat and terminal run from worktree', async () => {
    test.setTimeout(2 * 60_000)
    test.skip(!devpodHost || !remoteGitDir, 'No devpod configured — set ATELIER_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost || !remoteGitDir) return

    await openNewSessionModal(page)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('project-path').fill(remoteGitDir)

    const checkbox = page.getByTestId('use-worktree-checkbox')
    await checkbox.check()
    await expect(checkbox).toBeChecked()

    await page.getByTestId('start-session-button').click()

    // Modal must close immediately — before worktree creation finishes.
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 3_000 })

    // Sidebar row appears in creating-worktree state: dimmed, pulsing badge, label.
    const creatingRow = page.locator('[data-testid="session-row"][data-status="creating-worktree"]')
    await expect(creatingRow).toBeVisible({ timeout: 5_000 })
    await expect(creatingRow.getByTestId('session-creating-label')).toContainText('Setting up worktree')

    await page.screenshot({ path: join(artifactsDir, '02-worktree-creating-state.png') })

    // Wait for the row to leave creating-worktree (worktree created, harness started).
    await expect
      .poll(
        () => page.locator('[data-testid="session-row"][data-status="creating-worktree"]').count(),
        { timeout: 60_000, intervals: [1_000] }
      )
      .toBe(0)

    // DB must have worktree_path persisted for this session.
    const sessionRows = await queryDb<{ id: string; worktree_path: string | null }>(
      page,
      'SELECT id, worktree_path FROM sessions ORDER BY created_at DESC LIMIT 1'
    )
    expect(sessionRows[0]?.worktree_path, 'worktree_path must be set in DB after successful creation').toBeTruthy()
    expect(sessionRows[0]?.worktree_path).toContain('.atelier')
    const sessionId = sessionRows[0]!.id
    const worktreePath = sessionRows[0]!.worktree_path!
    const expectedBranch = `atelier-${sessionId.slice(0, 8)}`

    await page.screenshot({ path: join(artifactsDir, '02-worktree-created.png') })

    // Click the session and verify context bar shows worktree path + branch before first prompt.
    const sessionRow = page.locator('[data-testid="session-row"]').first()
    await sessionRow.click()

    const contextBar = page.getByTestId('composer-context-bar')
    await expect(contextBar).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('composer-context-claude-path')).toContainText(worktreePath.split('/').slice(-2).join('/'))
    await expect(page.getByTestId('composer-worktree-indicator')).toBeVisible()
    await expect(page.getByTestId('composer-context-branch')).toContainText(expectedBranch)
    await page.screenshot({ path: join(artifactsDir, '02-worktree-context-before-prompt.png') })

    const composer = page.getByTestId('composer-input')
    await composer.fill('Print your current working directory path. Reply with only the path, nothing else.')
    await page.getByTestId('send-button').click()
    await expect
      .poll(
        async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').last().textContent(),
        { timeout: 30_000 }
      )
      .toContain('.atelier/worktrees')
    await page.screenshot({ path: join(artifactsDir, '02-worktree-chat-in-worktree.png') })

    // Terminal tab must also open in the worktree directory.
    await page.getByTestId('tab-terminal').click()
    const term = page.getByTestId('terminal-body')
    await expect(term).toBeVisible({ timeout: 10_000 })
    await term.click()
    await page.waitForTimeout(3_000) // SSH + tmux attach
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect.poll(async () => term.textContent(), { timeout: 15_000 }).toContain('.atelier/worktrees')
    await page.screenshot({ path: join(artifactsDir, '02-worktree-terminal-in-worktree.png') })
  })

  test('use-worktree: closing session keeps worktree; reconnect after resume still uses worktree cwd', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-wt-close-'))
    execFileSync('git', ['init'], { cwd: projectDir })
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: projectDir }
    )

    await openNewSessionModal(page)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('use-worktree-checkbox').check()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 3_000 })
    await expect
      .poll(
        () => page.locator('[data-testid="session-row"][data-status="creating-worktree"]').count(),
        { timeout: 30_000, intervals: [500] }
      )
      .toBe(0)

    const sessionRows = await queryDb<{ id: string; worktree_path: string | null }>(
      page,
      'SELECT id, worktree_path FROM sessions ORDER BY created_at DESC LIMIT 1'
    )
    const sessionId = sessionRows[0]!.id
    const worktreePath = sessionRows[0]!.worktree_path
    expect(worktreePath).toBeTruthy()
    expect(existsSync(worktreePath!)).toBe(true)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await row.click()
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()
    await expect(page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)).toHaveCount(1, {
      timeout: 5_000
    })

    await expect
      .poll(async () => {
        const rows = await queryDb<{ worktree_path: string | null; closed_at: string | null }>(
          page,
          'SELECT worktree_path, closed_at FROM sessions WHERE id = ?',
          [sessionId]
        )
        return rows[0]
      })
      .toEqual(expect.objectContaining({ worktree_path: worktreePath, closed_at: expect.any(String) }))
    expect(existsSync(worktreePath!), 'worktree directory must survive Close').toBe(true)

    await reconnectClosedSessionFromHistory(page, sessionId)
    await expect
      .poll(async () => {
        const rows = await queryDb<{ worktree_path: string | null }>(
          page,
          'SELECT worktree_path FROM sessions WHERE id = ?',
          [sessionId]
        )
        return rows[0]?.worktree_path
      })
      .toBe(worktreePath)
    const activeComposer = page.locator('.composer-cache-entry.active')
    await expect(activeComposer.getByTestId('composer-worktree-indicator')).toBeVisible({ timeout: 15_000 })
    await expect(activeComposer.getByTestId('composer-context-claude-path')).toContainText(
      worktreePath!.split('/').slice(-2).join('/')
    )
  })

  test('use-worktree failure: non-git local path keeps session row with error', async () => {
    const noGitDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-local-no-git-'))
    const countBefore = await page.locator('[data-testid="session-row"]').count()

    await openNewSessionModal(page)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('project-path').fill(noGitDir)
    await page.getByTestId('use-worktree-checkbox').check()
    await page.getByTestId('start-session-button').click()

    await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 3_000 })
    await expect
      .poll(() => page.locator('[data-testid="session-row"]').count(), { timeout: 20_000, intervals: [300] })
      .toBe(countBefore + 1)
    await expect(page.locator('[data-testid="transcript-message"][data-role="system"]').last()).toContainText(/Error:/, {
      timeout: 15_000
    })
    await expect(page.locator('[data-testid="session-row"][data-status="creating-worktree"]')).toHaveCount(0)
  })

  test('use-worktree failure: non-git remote path keeps session row with error', async () => {
    test.skip(!devpodHost || !remoteNoGitDir, 'No devpod configured')
    if (!devpodHost || !remoteNoGitDir) return

    const countBefore = await page.locator('[data-testid="session-row"]').count()

    await openNewSessionModal(page)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('project-path').fill(remoteNoGitDir)
    await page.getByTestId('use-worktree-checkbox').check()
    await page.getByTestId('start-session-button').click()

    // Modal closes immediately even though worktree creation will fail.
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 3_000 })

    // setupWorktreeAsync: createWorktree fails → session kept with system error.
    await expect
      .poll(
        () => page.locator('[data-testid="session-row"]').count(),
        { timeout: 20_000, intervals: [300] }
      )
      .toBe(countBefore + 1)
    await expect(page.locator('[data-testid="transcript-message"][data-role="system"]').last()).toContainText(/Error:/, {
      timeout: 15_000
    })
    await expect(page.locator('[data-testid="session-row"][data-status="creating-worktree"]')).toHaveCount(0)

    await page.screenshot({ path: join(artifactsDir, '02-worktree-failure-kept.png') })
  })
})

test.describe('02-session-lifecycle — AI conformance connect', () => {
  test('AI conformance: exact production session opens panels fast; git diff deferred with timing logged', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    test.skip(!existsSync(PRODUCTION_ATELIER_DB), `Production DB missing — set ATELIER_SOURCE_DB (tried ${PRODUCTION_ATELIER_DB})`)

    let cloned: { name: string; messageCount: number }
    try {
      cloned = productionConformanceSessionMeta(PRODUCTION_ATELIER_DB, AI_CONFORMANCE_SESSION_ID)
    } catch (err) {
      test.skip(true, err instanceof Error ? err.message : String(err))
      return
    }
    expect(cloned.name).toBe('AI comformance')
    expect(cloned.messageCount).toBeGreaterThan(0)

    const conformanceUserData = mkdtempSync(join(tmpdir(), 'atelier-e2e-conformance-connect-'))
    seedE2eConfig(conformanceUserData)

    let electronApp: ElectronApplication
    let page: Page
    ;({ app: electronApp, page } = await launchApp(conformanceUserData))

    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts.find((h) => h.sshHost === 'qingqin-go.devpod-us-or') ?? hosts[0]
    test.skip(!devpodHost, 'No devpod configured — set ATELIER_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost) return

    await electronApp.close()
    cloneExactSessionFromProductionDb(
      join(conformanceUserData, 'data', 'atelier.sqlite'),
      AI_CONFORMANCE_SESSION_ID,
      PRODUCTION_ATELIER_DB
    )
    ;({ app: electronApp, page } = await launchApp(conformanceUserData))

    const clonedRows = await queryDb<{ c: number }>(
      page,
      'SELECT COUNT(*) AS c FROM messages WHERE session_id = ?',
      [AI_CONFORMANCE_SESSION_ID]
    )
    const clonedMessageCount = clonedRows[0]?.c ?? 0
    expect(clonedMessageCount).toBe(cloned.messageCount)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${AI_CONFORMANCE_SESSION_ID}"]`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('AI comformance')

    const connectStart = Date.now()
    await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 15_000 })
    const connectMs = Date.now() - connectStart

    await row.click()

    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 5_000 })
    await expect
      .poll(
        async () => {
          const dbCount =
            (
              await queryDb<{ c: number }>(
                page,
                'SELECT COUNT(*) AS c FROM messages WHERE session_id = ?',
                [AI_CONFORMANCE_SESSION_ID]
              )
            )[0]?.c ?? 0
          const userTurnCount =
            (
              await queryDb<{ c: number }>(
                page,
                `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'`,
                [AI_CONFORMANCE_SESSION_ID]
              )
            )[0]?.c ?? 0
          const result = await page.evaluate(
            (id) => window.atelier.listSessionMessages(id),
            AI_CONFORMANCE_SESSION_ID
          )
          const listCount = result.messages.length
          if (userTurnCount > 100) {
            return result.transcriptTruncated && listCount < dbCount && listCount >= 100
          }
          return dbCount === listCount && listCount >= clonedMessageCount
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(0)

    const essentialWorkspace = await page.evaluate(
      (id) => window.atelier.getSessionWorkspaceSnapshot(id),
      AI_CONFORMANCE_SESSION_ID
    )
    expect(essentialWorkspace?.diff.isRepo).toBe(true)
    expect((essentialWorkspace?.filesTree.length ?? 0)).toBeGreaterThan(0)
    expect((essentialWorkspace?.filesList.length ?? 0)).toBeGreaterThan(0)
    expect(essentialWorkspace?.tabTerminalPtyId).toContain(':tab-terminal')

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-panel-active')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('session-disconnected-panel')).toHaveCount(0)
    await expect(page.getByTestId('diff-refreshing')).toHaveCount(0)
    await expect(page.getByText('Loading diff…')).toHaveCount(0)
    await expect(page.getByText('Not a git repository')).toHaveCount(0)

    await page.getByTestId('tab-files').click()
    await expect(page.getByTestId('files-tree')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('session-disconnected-panel')).toHaveCount(0)
    await expect
      .poll(async () => page.locator('[data-testid="files-tree-root"], [data-testid="file-tree-dir"]').count(), {
        timeout: 15_000
      })
      .toBeGreaterThan(0)

    await page.getByTestId('tab-terminal').click()
    const term = page.getByTestId('terminal-body')
    await expect(term).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('session-disconnected-panel')).toHaveCount(0)
    await term.click()
    await page.waitForTimeout(3_000)
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => term.textContent(), { timeout: 20_000 })
      .toContain('.atelier/worktrees')

    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('composer-input')).toBeVisible()

    const log = appendMainLog(conformanceUserData)
    expect(log).toContain('"msg":"session:openTiming"')
    expect(log).toContain(AI_CONFORMANCE_SESSION_ID)
    expect(log).toContain('"gitDeferred":true')
    expect(log).toContain('"phase":"essential"')

    const essentialLine = log
      .split('\n')
      .find(
        (line) =>
          line.includes('session:openTiming') &&
          line.includes('"phase":"essential"') &&
          line.includes(AI_CONFORMANCE_SESSION_ID)
      )
    expect(essentialLine).toBeTruthy()
    const essentialPayload = JSON.parse(essentialLine!) as { essentialMs?: number; gitProbeMs?: number; sshWarmMs?: number }
    expect(essentialPayload.essentialMs ?? 0).toBeLessThan(15_000)
    expect(connectMs).toBeLessThan(15_000)

    await expect
      .poll(
        () => {
          const text = readFileSync(join(conformanceUserData, 'logs', 'main.log'), 'utf-8')
          return text.includes('"phase":"background"') && text.includes(AI_CONFORMANCE_SESSION_ID)
        },
        { timeout: 120_000 }
      )
      .toBe(true)

    const fullLog = readFileSync(join(conformanceUserData, 'logs', 'main.log'), 'utf-8')
    const backgroundLine = fullLog
      .split('\n')
      .find(
        (line) =>
          line.includes('session:openTiming') &&
          line.includes('"phase":"background"') &&
          line.includes(AI_CONFORMANCE_SESSION_ID)
      )
    expect(backgroundLine).toBeTruthy()
    const backgroundPayload = JSON.parse(backgroundLine!) as { backgroundGitMs?: number; backgroundTotalMs?: number }
    expect(typeof backgroundPayload.backgroundGitMs).toBe('number')
    expect(backgroundPayload.backgroundGitMs ?? 0).toBeGreaterThan(0)

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-refreshing')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('diff-panel-active')).toBeVisible()
    const finalWorkspace = await page.evaluate(
      (id) => window.atelier.getSessionWorkspaceSnapshot(id),
      AI_CONFORMANCE_SESSION_ID
    )
    expect(finalWorkspace?.diff.isRepo).toBe(true)

    await page.screenshot({ path: join(artifactsDir, '02-conformance-connect.png') })
    await electronApp.close().catch(() => undefined)
  })
})

test.describe('02-session-lifecycle (gardenia worktree migration)', () => {
  test('legacy .gardenia/worktrees paths migrate to .atelier on launch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-gardenia-migrate-'))
    seedSkipOnboarding(userDataDir)

    const projectDir = mkdtempSync(join(tmpdir(), 'atelier-gardenia-migrate-repo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir })
    writeFileSync(join(projectDir, 'README.md'), '# migrate\n')
    execFileSync('git', ['add', 'README.md'], { cwd: projectDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir })

    const sessionId = randomUUID()
    const legacyWorktreePath = join(projectDir, '.gardenia', 'worktrees', sessionId)
    const branch = `gardenia-${sessionId.slice(0, 8)}`
    mkdirSync(dirname(legacyWorktreePath), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-b', branch, legacyWorktreePath], { cwd: projectDir })

    const { app, page } = await launchApp(userDataDir)
    try {
      await page.evaluate(
        ({ sessionId: id, projectPath, worktreePath }) => {
          return window.atelier.debugExecDb(
            `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order, worktree_path, permission_mode)
             VALUES (?, 'legacy worktree', 0, ?, 'claude-code', NULL, NULL, 0, NULL, datetime('now'), NULL, NULL, 0, ?, 'default')`,
            [id, projectPath, worktreePath]
          )
        },
        { sessionId, projectPath: projectDir, worktreePath: legacyWorktreePath }
      )

      await page.evaluate(() =>
        window.atelier.debugExecDb(`DELETE FROM migrations WHERE name = '0010_gardenia_to_atelier_worktrees'`)
      )

      await app.close()

      const relaunch = await launchApp(userDataDir)
      try {
        const rows = await queryDb<{ worktree_path: string | null }>(
          relaunch.page,
          'SELECT worktree_path FROM sessions WHERE id = ?',
          [sessionId]
        )
        const migratedPath = rows[0]?.worktree_path
        expect(migratedPath).toContain('/.atelier/worktrees/')
        expect(existsSync(migratedPath!), 'migrated worktree directory must exist').toBe(true)
        expect(existsSync(legacyWorktreePath), 'legacy worktree directory must be gone').toBe(false)

        const branches = execFileSync('git', ['-C', projectDir, 'branch', '--list', 'atelier-*'], {
          encoding: 'utf8'
        })
        expect(branches).toContain(`atelier-${sessionId.slice(0, 8)}`)
      } finally {
        await relaunch.app.close()
      }
    } finally {
      await app.close().catch(() => undefined)
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
