import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression coverage for fix-session-cost-total-overcounted.
 *
 * Root cause (verified for real against the SDK via a 3-turn probe, raw
 * `main.log`): the SDK's `result.total_cost_usd` is CUMULATIVE for the
 * current live `query()` connection, not a per-turn delta. Turn 2 on a
 * connection reported its own standalone cost; turn 3 on the SAME
 * connection (fed via `streamInput`, no `resume()` in between) reported
 * turn2+turn3 combined. It resets to a fresh 0 baseline whenever a new
 * connection starts (`start()`/`resume()`) rather than carrying the whole
 * historical session cost forward. `SessionManager`'s `case 'result'` used
 * to hand this raw cumulative value straight to `SessionStore.addCost`,
 * which additively sums it into a running total — so turn 2's already-
 * inflated stored total got summed AGAIN on top of turn 3's own cumulative
 * report, compounding worse every turn on a connection.
 *
 * The fix tracks each live connection's last-seen `total_cost_usd`
 * (`LiveStream.connectionCostUsd`) and only persists the delta since that
 * baseline, resetting the baseline to 0 whenever a genuinely new connection
 * starts.
 *
 * This spec proves:
 *  1. Across 3 real turns on ONE connection (no reconnect), the persisted/
 *     displayed total tracks the sum of each turn's OWN real dollar cost
 *     (independently recomputed from the turn's raw token usage via known
 *     Sonnet rates), not the inflated compounding sum a bug would produce.
 *  2. Across a forced reconnect (model-picker change, per
 *     `model-effort-picker.spec.ts`), the next turn's spend is added
 *     exactly once — neither dropped to $0 nor double-counted against the
 *     pre-reconnect total.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

// Anthropic per-token USD rates for the Sonnet family (per M tokens, from
// Morpheus's own rate table at packages/shared/src/cost.ts, cross-checked
// against the real SDK-reported total_cost_usd during reproduction: turn-
// by-turn recomputation from raw usage matched the SDK's own value to 6
// decimal places for a claude-sonnet-5 session).
const RATE_PER_TOKEN = {
  input: 3 / 1_000_000,
  output: 15 / 1_000_000,
  cacheWrite1h: 6 / 1_000_000,
  cacheWrite5m: 3.75 / 1_000_000,
  cacheRead: 0.3 / 1_000_000
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
}

function costFromUsage(usage: RawUsage): number {
  return (
    (usage.input_tokens ?? 0) * RATE_PER_TOKEN.input +
    (usage.output_tokens ?? 0) * RATE_PER_TOKEN.output +
    (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) * RATE_PER_TOKEN.cacheWrite1h +
    (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) * RATE_PER_TOKEN.cacheWrite5m +
    (usage.cache_read_input_tokens ?? 0) * RATE_PER_TOKEN.cacheRead
  )
}

interface CostLogEntry {
  sessionId: string
  deltaUsd: number
  rawTotalCostUsd: number
  totalCostUsd: number
  usage: RawUsage
}

/** Parses every real `SessionManager` "session cost updated" log line for a session, in order. */
function readCostLogEntries(logPath: string, sessionId: string): CostLogEntry[] {
  const raw = readFileSync(logPath, 'utf-8')
  return raw
    .split('\n')
    .filter((l) => l.includes('session cost updated') && l.includes(sessionId))
    .map((l) => JSON.parse(l) as CostLogEntry)
}

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

async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.gardenia.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

async function sendFollowUpAndWait(page: Page, prompt: string, expectedWord: string): Promise<void> {
  await page.getByTestId('composer-input').fill(prompt)
  await page.getByTestId('send-button').click()
  await expect
    .poll(
      async () => {
        const texts = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').allTextContents()
        return texts.some((t) => t.includes(expectedWord))
      },
      { timeout: 60_000 }
    )
    .toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.describe('session-cost-tracking (fix-session-cost-total-overcounted)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localProjectDir: string
  let sessionId: string
  let logPath: string
  let totalAfterThreeTurns: number

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-cost2-'))
    seedSkipOnboarding(userDataDir)
    localProjectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-cost2-project-'))
    writeFileSync(join(localProjectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('3 real turns in one session: persisted total matches sum of each turn\'s independently-recomputed cost, not a compounding over-count', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)

    await stubProjectFolder(electronApp, localProjectDir)
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('pick-project-folder').click()
    await expect(page.getByTestId('pick-project-folder')).toContainText(localProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: ONE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await sendFollowUpAndWait(page, 'Reply with exactly the single word: TWO', 'TWO')
    await sendFollowUpAndWait(page, 'Reply with exactly the single word: THREE', 'THREE')

    // Give the final "session cost updated" log line a moment to flush.
    await page.waitForTimeout(500)

    const entries = readCostLogEntries(logPath, sessionId)
    expect(entries.length).toBe(3)

    // Independent cross-check: recompute each turn's OWN dollar cost from
    // its raw token usage via known Sonnet rates, and sum those — this is
    // what Morpheus-style fresh-recomputation would produce, and what the
    // fixed `deltaUsd` this app persists should equal turn-by-turn.
    let expectedCumulative = 0
    for (const entry of entries) {
      const independentPerTurnCost = costFromUsage(entry.usage)
      expectedCumulative += independentPerTurnCost
      // The app's own computed delta for this turn should match the
      // independent per-turn recomputation closely (not the raw SDK
      // cumulative-so-far value, which would be larger from turn 2 on).
      expect(Math.abs(entry.deltaUsd - independentPerTurnCost)).toBeLessThan(0.0005)
      // And the persisted running total after this turn should match the
      // running sum of real per-turn costs so far, not a compounding
      // over-count (which would already diverge visibly by turn 3).
      expect(Math.abs(entry.totalCostUsd - expectedCumulative)).toBeLessThan(0.001)
    }

    // Sanity: with the OLD (buggy) additive-of-raw-cumulative-value logic,
    // turn 3's persisted total would have been
    // entries[0].totalCostUsd_old + entries[1].rawTotalCostUsd + entries[2].rawTotalCostUsd,
    // i.e. compounding every connection-cumulative report on top of the
    // last. Confirm the fixed total is materially smaller than that faulty
    // reconstruction whenever the raw reports actually were cumulative
    // (rawTotalCostUsd > deltaUsd for turns after the first on the same
    // connection).
    const rawCumulativeInflatedTotal = entries.reduce((sum, e) => sum + e.rawTotalCostUsd, 0)
    if (rawCumulativeInflatedTotal > expectedCumulative + 0.001) {
      expect(entries[entries.length - 1].totalCostUsd).toBeLessThan(rawCumulativeInflatedTotal)
    }

    const rows = await queryDb<{ total_cost_usd: number }>(page, 'SELECT total_cost_usd FROM sessions WHERE id = ?', [
      sessionId
    ])
    expect(rows.length).toBe(1)
    totalAfterThreeTurns = rows[0].total_cost_usd
    expect(Math.abs(totalAfterThreeTurns - expectedCumulative)).toBeLessThan(0.001)

    const chip = page.getByTestId('cost-chip')
    await expect
      .poll(async () => (await chip.textContent())?.trim(), { timeout: 10_000 })
      .toBe(`$${totalAfterThreeTurns.toFixed(2)}`)

    await page.screenshot({ path: join(artifactsDir, '16-session-cost-tracking-after-three-turns.png') })
  })

  // ── Reconnect case: model-picker change forces a fresh resume() ────────
  test('reconnect (model change forces fresh resume()) adds the next turn once — no reset to $0, no double-count of prior spend', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)

    await page.getByTestId('model-picker-button').click()
    await expect(page.getByTestId('model-picker-popover')).toBeVisible()
    await page.getByTestId('model-option-claude-opus-4-8').click()
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)

    const rawLogBefore = readFileSync(logPath, 'utf-8')
    const entriesBefore = readCostLogEntries(logPath, sessionId)
    expect(entriesBefore.length).toBe(3)

    await sendFollowUpAndWait(page, 'Reply with exactly the single word: FOUR', 'FOUR')
    await page.waitForTimeout(500)

    // Confirm this really went through a fresh reconnect, not the fast
    // streamInput-only path (per model-effort-picker.spec.ts's pattern).
    const rawLogAfter = readFileSync(logPath, 'utf-8')
    expect(rawLogAfter.length).toBeGreaterThan(rawLogBefore.length)
    expect(rawLogAfter).toMatch(/sendUserMessage: (no live harness session, reconnecting via resume\(\)|model\/effort selection changed, applying from next turn)/)

    const entriesAfter = readCostLogEntries(logPath, sessionId)
    expect(entriesAfter.length).toBe(4)
    const turn4 = entriesAfter[3]

    // New connection: the SDK's own baseline resets to 0, so turn 4's raw
    // report IS its own real cost (nothing to subtract) and the persisted
    // delta should equal that raw value almost exactly.
    expect(Math.abs(turn4.deltaUsd - turn4.rawTotalCostUsd)).toBeLessThan(0.0005)
    // The new connection's own reported cost must be a real, non-zero turn
    // of spend, not the whole prior session's historical total reappearing.
    expect(turn4.rawTotalCostUsd).toBeGreaterThan(0)

    const rows = await queryDb<{ total_cost_usd: number }>(page, 'SELECT total_cost_usd FROM sessions WHERE id = ?', [
      sessionId
    ])
    const totalAfterFourTurns = rows[0].total_cost_usd

    // Cost was carried over (not reset to 0 on reconnect)...
    expect(totalAfterFourTurns).toBeGreaterThan(totalAfterThreeTurns)
    // ...and added exactly once (not double-counted): the increase should
    // equal turn 4's own delta, not turn 4's delta plus a repeat of the
    // pre-reconnect total.
    expect(Math.abs(totalAfterFourTurns - totalAfterThreeTurns - turn4.deltaUsd)).toBeLessThan(0.001)
    expect(totalAfterFourTurns).toBeLessThan(totalAfterThreeTurns * 2 + 1)

    const chip = page.getByTestId('cost-chip')
    await expect
      .poll(async () => (await chip.textContent())?.trim(), { timeout: 10_000 })
      .toBe(`$${totalAfterFourTurns.toFixed(2)}`)

    await page.screenshot({ path: join(artifactsDir, '16-session-cost-tracking-after-reconnect.png') })
  })
})
