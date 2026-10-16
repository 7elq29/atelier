import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Model picker must list the live SDK `/model` options
 * (`initializationResult().models` → `models_updated`), not a hardcoded
 * generation catalog (Opus 4.8 / Sonnet 5 / …).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

function latestLiveModelIds(logPath: string, sessionId: string): string[] {
  const raw = readFileSync(logPath, 'utf-8')
  const entries = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.msg === 'harness event: models_updated' && e.sessionId === sessionId)
  if (entries.length === 0) return []
  return (entries[entries.length - 1].modelIds as string[]) ?? []
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-fix: model picker lists live SDK /model options', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let logPath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-model-list-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-model-list-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    logPath = await page.evaluate(() => window.atelier.getLogFilePath())
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('picker rows match models_updated (live /model list), not the old hardcoded catalog', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    mkdirSync(artifactsDir, { recursive: true })

    await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => latestLiveModelIds(logPath, sessionId).length, { timeout: 60_000 })
      .toBeGreaterThan(0)

    const liveIds = latestLiveModelIds(logPath, sessionId)
    expect(liveIds).toEqual(expect.arrayContaining(['default', 'opus', 'sonnet', 'haiku']))

    await page.getByTestId('model-picker-button').click()
    const popover = page.getByTestId('model-picker-popover')
    await expect(popover).toBeVisible()

    // Wait until live list has replaced any pre-init fallback.
    await expect(page.getByTestId('model-option-default')).toBeVisible({ timeout: 30_000 })

    const modelOptionIds = await popover
      .locator('[data-testid^="model-option-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))

    await page.screenshot({ path: join(artifactsDir, 'fix-model-picker-option-list.png') })

    expect(modelOptionIds.sort()).toEqual(liveIds.map((id) => `model-option-${id}`).sort())

    // Core /model aliases must be present (org-gated extras like Mythos may also appear).
    expect(liveIds).toEqual(expect.arrayContaining(['default', 'opus', 'sonnet', 'haiku']))

    // Superseded generation catalog rows must not appear unless the live SDK lists them.
    for (const stale of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-mythos-5', 'claude-fable-5']) {
      if (!liveIds.includes(stale)) {
        expect(modelOptionIds).not.toContain(`model-option-${stale}`)
      }
    }
  })
})
