import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const costLogPath = join(artifactsDir, '10a-cost-tracking.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(costLogPath, '')

function configPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

/** Raw read-only SQL query against the app's real SQLite DB, via the same `debug:queryDb` IPC channel other specs use. */
async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

/** Appends the real main-process log's "session cost updated" lines (from SessionManager's `case 'result'`) into the proof artifact. */
async function appendCostLog(page: Page, label: string): Promise<void> {
  const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
  if (!existsSync(logFilePath)) return
  const raw = readFileSync(logFilePath, 'utf-8')
  const lines = raw.split('\n').filter((l) => /session cost updated/.test(l))
  writeFileSync(costLogPath, `[${label}]\n${lines.join('\n')}\n`, { flag: 'a' })
}

/** Parses a rendered "$X.XX" chip into its numeric dollar value. */
function parseChipDollars(text: string): number {
  const match = text.trim().match(/^\$(\d+\.\d{2})$/)
  expect(match, `chip text "${text}" should match "$X.XX"`).not.toBeNull()
  return Number(match![1])
}

test.describe.configure({ mode: 'serial' })

test.describe('10a-enrichment-cost-tracking', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localProjectDir: string
  let sessionId: string
  let firstTurnCost: number

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cost-'))
    seedSkipOnboarding(userDataDir)
    localProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cost-project-'))
    writeFileSync(join(localProjectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. First real turn: chip shows a real non-zero cost matching SQLite ──
  test('cost chip shows a real non-zero dollar amount matching the SDK-reported total_cost_usd after the first turn', async () => {
    await stubProjectFolder(electronApp, localProjectDir)
    await openNewSessionModal(page)

    await page.getByTestId('pick-project-folder').click()
    await expect(page.getByTestId('pick-project-folder')).toContainText(localProjectDir)

    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()

    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Before the first turn completes, the chip should already be rendered
    // (default $0.00), not hidden entirely.
    const chip = page.getByTestId('cost-chip')
    await expect(chip).toBeVisible()

    // Wait for the real assistant reply to land (first turn complete).
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    // The chip updates live (via session.updated -> refresh()) once the
    // harness's real `result` event lands and SessionStore.addCost persists it.
    await expect
      .poll(async () => parseChipDollars((await chip.textContent()) ?? ''), { timeout: 15_000 })
      .toBeGreaterThan(0)

    firstTurnCost = parseChipDollars((await chip.textContent()) ?? '')

    // Cross-check against the real SQLite column (source of truth written by
    // SessionStore.addCost from the harness's own `result.totalCostUsd`).
    const rows = await queryDb<{ total_cost_usd: number }>(page, 'SELECT total_cost_usd FROM sessions WHERE id = ?', [
      sessionId
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].total_cost_usd).toBeGreaterThan(0)
    // toFixed(2) rounding tolerance.
    expect(Math.abs(rows[0].total_cost_usd - firstTurnCost)).toBeLessThan(0.005)

    await appendCostLog(page, 'after-first-turn')
    const log = readFileSync(costLogPath, 'utf-8')
    expect(log).toContain('session cost updated')

    await page.screenshot({ path: join(artifactsDir, '10a-cost-chip-first-turn.png') })
  })

  // ── 2. Second real turn: cost accumulates (running total, not overwritten) ──
  test('a second turn ADDS to the running total rather than replacing it', async () => {
    const chip = page.getByTestId('cost-chip')

    await page.getByTestId('composer-input').fill('Reply with exactly the single word: PONG')
    await page.getByTestId('send-button').click()

    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').allTextContents()
          return texts.some((t) => t.includes('PONG'))
        },
        { timeout: 60_000 }
      )
      .toBe(true)

    await expect
      .poll(async () => parseChipDollars((await chip.textContent()) ?? ''), { timeout: 15_000 })
      .toBeGreaterThan(firstTurnCost)

    const rows = await queryDb<{ total_cost_usd: number }>(page, 'SELECT total_cost_usd FROM sessions WHERE id = ?', [
      sessionId
    ])
    expect(rows[0].total_cost_usd).toBeGreaterThan(firstTurnCost)

    const chipAfterSecondTurn = parseChipDollars((await chip.textContent()) ?? '')
    expect(Math.abs(rows[0].total_cost_usd - chipAfterSecondTurn)).toBeLessThan(0.005)

    await appendCostLog(page, 'after-second-turn')
  })

  // ── 3. Persistence across a REAL relaunch ────────────────────────────────
  test('accumulated cost persists across a real app relaunch', async () => {
    const preRelaunchRows = await queryDb<{ total_cost_usd: number }>(
      page,
      'SELECT total_cost_usd FROM sessions WHERE id = ?',
      [sessionId]
    )
    const preRelaunchTotal = preRelaunchRows[0].total_cost_usd

    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()

    const chip = page.getByTestId('cost-chip')
    await expect(chip).toBeVisible()
    await expect
      .poll(async () => parseChipDollars((await chip.textContent()) ?? ''), { timeout: 10_000 })
      .toBe(Number(preRelaunchTotal.toFixed(2)))

    const rows = await queryDb<{ total_cost_usd: number }>(page, 'SELECT total_cost_usd FROM sessions WHERE id = ?', [
      sessionId
    ])
    expect(rows[0].total_cost_usd).toBe(preRelaunchTotal)

    await page.screenshot({ path: join(artifactsDir, '10a-cost-chip-after-relaunch.png') })
  })

  // ── 4. UI-match: chip visible in both light and dark themes ─────────────
  test('UI-match: cost chip renders in both light and dark themes', async () => {
    const chip = page.getByTestId('cost-chip')
    await expect(chip).toBeVisible()

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await expect(chip).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '10a-cost-chip-light.png') })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect(chip).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '10a-cost-chip-dark.png') })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  })
})
