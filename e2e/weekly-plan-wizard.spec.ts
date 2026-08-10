import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const TEST_DATE = '2026-07-31'
const ISO_WEEK = '2026-W31'
const MARKER = 'Weekly plan wizard e2e win'

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let vaultRoot: string
let weeklyPath: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  vaultRoot = join(vaultParent, 'vault')
  mkdirSync(join(vaultRoot, '02.weeklynotes'), { recursive: true })
  mkdirSync(join(vaultRoot, '92.templates'), { recursive: true })
  mkdirSync(join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31'), { recursive: true })
  weeklyPath = join(vaultRoot, '02.weeklynotes', `${ISO_WEEK}.md`)

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ATELIER_TEST_VAULT_ROOT: vaultRoot,
      ATELIER_TEST_DATE: TEST_DATE
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForSelector('#root', { timeout: 30_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

test('weekly plan: + opens wizard and creates vault weekly note', async () => {
  await expect(page.getByTestId('weekly-plan-row')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('weekly-plan-create-button')).toBeVisible()
  expect(existsSync(weeklyPath)).toBe(false)

  await page.getByTestId('weekly-plan-create-button').click()
  await expect(page.getByTestId('weekly-plan-panel')).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('weekly-plan-next').click()
  await page.locator('.wp-field input').first().fill(MARKER)
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('weekly-plan-next').click()
  }
  await page.getByTestId('weekly-plan-next').click()

  await expect(page.getByTestId('weekly-plan-done')).toBeVisible({ timeout: 15_000 })
  expect(existsSync(weeklyPath)).toBe(true)
  const body = readFileSync(weeklyPath, 'utf-8')
  expect(body).toContain(MARKER)
  await expect(page.getByTestId('weekly-plan-create-button')).toHaveCount(0)
})
