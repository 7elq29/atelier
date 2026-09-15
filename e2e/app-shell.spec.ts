import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

let electronApp: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-'))
  seedE2eConfig(userDataDir)
  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`]
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await electronApp.close()
})

test('window title is Atelier', async () => {
  await expect.poll(() => page.title()).toBe('Atelier')
})

test('integrated title bar on macOS (hiddenInset chrome)', async () => {
  const platform = await page.evaluate(() => window.atelier.platform)
  test.skip(platform !== 'darwin', 'custom title bar is macOS-only')
  await expect(page.getByTestId('window-title-bar')).toBeVisible()
  await expect(page.getByTestId('window-title-bar')).toContainText('Atelier')
})

test('#root has rendered children', async () => {
  const childCount = await page.locator('#root').evaluate((el) => el.children.length)
  expect(childCount).toBeGreaterThan(0)
})

test('IPC round-trip returns a real app version', async () => {
  // There is no visible "debug corner" in the normal UI (see
  // bug-remove-version-corner.spec.ts) — the app:getVersion IPC bridge is
  // exercised directly here instead of reading it off the DOM.
  const directVersion = await page.evaluate(() => window.atelier.getAppVersion())
  expect(directVersion).toMatch(/^\d+\.\d+\.\d+/)

  // Calling it a second time should be stable/idempotent.
  const secondCall = await page.evaluate(() => window.atelier.getAppVersion())
  expect(secondCall).toBe(directVersion)
})

test('main-process log file contains "app ready" and IPC entries', async () => {
  const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
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

  test('sidebar starts with New Group instead of a decorative app mark', async () => {
    await expect(page.getByTestId('app-mark')).toHaveCount(0)
    const sidebar = await page.getByTestId('sidebar').boundingBox()
    const newGroup = await page.getByTestId('new-group-button').boundingBox()
    expect(sidebar).not.toBeNull()
    expect(newGroup).not.toBeNull()
    expect(newGroup!.y - sidebar!.y).toBe(8)
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

test('keyboard hints: Ctrl+C does not filter badges while ⌘ is held', async () => {
  await page.locator('#app').click()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }))
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 10_000 })
  const before = await page.locator('[data-testid^="keyboard-hint-badge-"]').count()
  expect(before).toBeGreaterThan(0)

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })

  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible()
  await expect(page.locator('[data-testid^="keyboard-hint-badge-"]')).toHaveCount(before)

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }))
  })
  await expect(page.getByTestId('keyboard-hints-overlay')).toHaveCount(0)
})

test('keyboard hints: ⌘+f switches to Files tab while hints are active', async () => {
  const sessionRow = page.locator('[data-testid="session-row"]').first()
  if ((await sessionRow.count()) === 0) {
    test.skip(true, 'no session available for tab shortcut test')
  }
  await sessionRow.click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 15_000 })

  await page.locator('#app').click()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }))
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('keyboard-hint-tab-badge-h')).toBeVisible()
  await expect(page.getByTestId('keyboard-hint-tab-badge-d')).toBeVisible()
  await expect(page.getByTestId('keyboard-hint-tab-badge-f')).toBeVisible()
  await expect(page.getByTestId('keyboard-hint-tab-badge-t')).toBeVisible()

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })

  await expect(page.getByTestId('keyboard-hints-overlay')).toHaveCount(0)
  await expect(page.getByTestId('tab-files')).toHaveClass(/active/)
})

test('keyboard hints: ⌘+c does not switch tabs while hints are active', async () => {
  const sessionRow = page.locator('[data-testid="session-row"]').first()
  if ((await sessionRow.count()) === 0) {
    test.skip(true, 'no session available for tab shortcut test')
  }
  await sessionRow.click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('tab-diff')).toHaveClass(/active/)

  await page.locator('#app').click()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }))
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 10_000 })

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })

  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible()
  await expect(page.getByTestId('tab-diff')).toHaveClass(/active/)

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }))
  })
  await expect(page.getByTestId('keyboard-hints-overlay')).toHaveCount(0)
})

test('keyboard hints: reserved letters do not appear as chrome badges while ⌘ is held', async () => {
  await page.locator('#app').click()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }))
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 10_000 })

  for (const letter of ['a', 'c', 'v', 'x', 'h', 'd', 'f', 't', 'p']) {
    await expect(page.getByTestId(`keyboard-hint-badge-${letter}`)).toHaveCount(0)
  }

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }))
  })
  await expect(page.getByTestId('keyboard-hints-overlay')).toHaveCount(0)
})
