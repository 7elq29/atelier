import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

let electronApp: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-'))

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`]
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await electronApp.close()
})

test('window title is Gardenia', async () => {
  await expect.poll(() => page.title()).toBe('Gardenia')
})

test('#root has rendered children', async () => {
  const childCount = await page.locator('#root').evaluate((el) => el.children.length)
  expect(childCount).toBeGreaterThan(0)
})

test('IPC round-trip returns a real app version', async () => {
  const versionLocator = page.locator('[data-testid="app-version"]')
  await expect(versionLocator).not.toHaveText('loading…', { timeout: 10_000 })
  const versionText = await versionLocator.textContent()
  expect(versionText).toMatch(/^\d+\.\d+\.\d+/)

  // Also call it directly to make sure the bridge itself (not just the React
  // effect) resolves a real value.
  const directVersion = await page.evaluate(() => window.gardenia.getAppVersion())
  expect(directVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(directVersion).toBe(versionText)
})

test('main-process log file contains "app ready" and IPC entries', async () => {
  const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
  expect(existsSync(logPath)).toBe(true)

  const contents = readFileSync(logPath, 'utf-8')
  const lines = contents.trim().split('\n').filter(Boolean)
  const entries = lines.map((l) => JSON.parse(l))

  const appReady = entries.find((e) => e.process === 'main' && e.msg === 'app ready')
  expect(appReady).toBeTruthy()

  const ipcEntry = entries.find((e) => e.process === 'main' && e.msg === 'ipc app:getVersion invoked')
  expect(ipcEntry).toBeTruthy()

  mkdirSync(artifactsDir, { recursive: true })
  copyFileSync(logPath, join(artifactsDir, '00-main.log'))
})

test('shell renders shared.css design tokens, not Electron/browser defaults', async () => {
  mkdirSync(artifactsDir, { recursive: true })
  await page.screenshot({ path: join(artifactsDir, '00-launch.png') })

  const { backgroundColor, fontFamily } = await page.evaluate(() => {
    const style = getComputedStyle(document.body)
    return { backgroundColor: style.backgroundColor, fontFamily: style.fontFamily }
  })

  // shared.css --bg-app (dark "Soft Paper Night"): #1c1a16 -> rgb(28, 26, 22)
  expect(backgroundColor).toBe('rgb(28, 26, 22)')
  // shared.css --font-ui starts with -apple-system, ... never Electron's
  // default "system-ui"/"Times New Roman" fallback.
  expect(fontFamily.startsWith('-apple-system')).toBe(true)
  expect(fontFamily).not.toBe('system-ui')
})
