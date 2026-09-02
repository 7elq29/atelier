import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { seedSkipOnboarding } from './e2e-config'

const SESSION_ID = 'a35b2ba0-f738-4ce1-8c6e-500acad8be2c'
const PROD_USER_DATA = join(process.env.HOME!, 'Library/Application Support/Atelier')
const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')

function copyProdUserData(dest: string): void {
  mkdirSync(join(dest, 'data'), { recursive: true })
  const srcDb = join(PROD_USER_DATA, 'data/atelier.sqlite')
  const destDb = join(dest, 'data/atelier.sqlite')
  execSync(`sqlite3 "${srcDb}" ".backup '${destDb}'"`)
  const cfgSrc = join(PROD_USER_DATA, 'data/config.json')
  if (existsSync(cfgSrc)) cpSync(cfgSrc, join(dest, 'data/config.json'), { force: true })
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('measure Fix ray init Diff tab open', async () => {
  test.setTimeout(300_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-measure-diff-'))
  copyProdUserData(userDataDir)
  seedSkipOnboarding(userDataDir)

  const { app, page } = await launchApp(userDataDir)
  try {
    await expect(page.getByTestId('session-list')).toBeVisible({ timeout: 60_000 })

    const otherRow = page.locator(`[data-testid="session-row"]:not([data-session-id="${SESSION_ID}"])`).first()
    if (await otherRow.count()) {
      await otherRow.click()
      await page.waitForTimeout(300)
    }

    const tSessionClick = Date.now()
    await page.locator(`[data-testid="session-row"][data-session-id="${SESSION_ID}"]`).click()
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${SESSION_ID}"]`)).toHaveAttribute(
      'data-active',
      'true',
      { timeout: 120_000 }
    )
    const sessionActiveMs = Date.now() - tSessionClick

    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)

    const tDiffClick = Date.now()
    await page.getByTestId('tab-diff').click()

    const refreshing = page.getByTestId('diff-refreshing')
    let refreshingSeenAt: number | null = null
    try {
      await refreshing.waitFor({ state: 'visible', timeout: 5_000 })
      refreshingSeenAt = Date.now() - tDiffClick
    } catch {
      // ok
    }

    await expect(page.getByTestId('diff-panel-active')).toBeVisible({ timeout: 180_000 })
    const panelVisibleMs = Date.now() - tDiffClick

    let refreshingDoneMs: number | null = null
    if (refreshingSeenAt != null) {
      try {
        await refreshing.waitFor({ state: 'hidden', timeout: 180_000 })
        refreshingDoneMs = Date.now() - tDiffClick
      } catch {
        refreshingDoneMs = Date.now() - tDiffClick
      }
    }

    const fileRow = page.getByTestId('diff-file-row')
    let fileRowsVisibleMs: number | null = null
    if (await fileRow.count()) {
      await expect(fileRow.first()).toBeVisible({ timeout: 180_000 })
      fileRowsVisibleMs = Date.now() - tDiffClick
    }

    const bodyText = await page.locator('.tab-content[data-tab="diff"]').innerText()
    const badgeText = (await page.getByTestId('tab-diff-count').textContent().catch(() => null)) ?? 'n/a'

    console.log(
      JSON.stringify(
        {
          session: 'Fix ray init',
          sessionId: SESSION_ID,
          sessionActiveMs,
          diffTab: {
            panelVisibleMs,
            refreshingBannerSeenAtMs: refreshingSeenAt,
            refreshingBannerDoneMs: refreshingDoneMs,
            fileRowsVisibleMs,
            fileRowCount: await fileRow.count(),
            tabBadge: badgeText.trim(),
            diffBodySnippet: bodyText.slice(0, 200)
          }
        },
        null,
        2
      )
    )
  } finally {
    await app.close()
  }
})
