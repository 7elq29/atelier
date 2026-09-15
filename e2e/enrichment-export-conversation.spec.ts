import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


/** Deterministic save path for the native Save dialog, same stubbing pattern as showOpenDialog above. */
async function stubSavePath(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, savePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: savePath })) as typeof dialog.showSaveDialog
  }, path)
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, 'utf-8')
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`file never appeared: ${path}`)
}

/** Raw read-only SQL query against the app's real SQLite DB, via the same `debug:queryDb` IPC channel other specs use. */
async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('10c-enrichment-export-conversation', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localProjectDir: string
  let exportDir: string
  let sessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-export-'))
    seedSkipOnboarding(userDataDir)
    localProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-export-project-'))
    writeFileSync(join(localProjectDir, 'README.md'), '# test project\n')
    exportDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-export-out-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Set up a real session with a real SDK exchange including a tool call ──
  test('creates a session with a real assistant reply and a completed Bash tool call', async () => {
    test.setTimeout(120_000)
        await openNewSessionModal(page)

    await page.getByTestId('project-path').fill(localProjectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the Bash tool to run exactly: echo export-check. Then reply with exactly the single word: DONE.'
    )
    await page.getByTestId('start-session-button').click()

    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').allTextContents()
          return texts.some((t) => t.includes('DONE'))
        },
        { timeout: 90_000 }
      )
      .toBe(true)
  })

  // ── 2. Topbar no longer shows export/search icons ──
  test('topbar has no export or search icons; cost sits beside the title in grey', async () => {
    const title = page.getByTestId('main-title')
    const chip = page.getByTestId('cost-chip')
    await expect(chip).toBeVisible()
    await expect(page.getByTestId('export-menu-button')).toHaveCount(0)
    await expect(page.getByTestId('toggle-transcript-search')).toHaveCount(0)

    const titleBox = await title.boundingBox()
    const chipBox = await chip.boundingBox()
    const tabsBox = await page.locator('.tab-strip').boundingBox()
    expect(titleBox).not.toBeNull()
    expect(chipBox).not.toBeNull()
    expect(tabsBox).not.toBeNull()
    if (titleBox && chipBox && tabsBox) {
      expect(chipBox.x).toBeGreaterThan(titleBox.x + titleBox.width - 1)
      expect(chipBox.x + chipBox.width).toBeLessThan(tabsBox.x + 1)
    }

    const tertiary = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim()
      const rgb = getComputedStyle(probe).color
      probe.remove()
      return rgb
    })
    expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe(tertiary)

    await page.screenshot({ path: join(artifactsDir, 'topbar-without-export-search.png') })
  })

  // ── 3. Export as Markdown: real Save dialog, real file, readable content ──
  test('exports the transcript as a real, readable Markdown file', async () => {
    const mdPath = join(exportDir, 'transcript.md')
    await stubSavePath(electronApp, mdPath)

    const saved = await page.evaluate(
      ({ id }) => window.atelier.exportTranscript(id, 'markdown'),
      { id: sessionId }
    )
    expect(saved).toBe(mdPath)

    const content = await waitForFile(mdPath)
    const rows = await queryDb<{ name: string }>(page, 'SELECT name FROM sessions WHERE id = ?', [sessionId])
    expect(content).toContain(rows[0].name)
    expect(content).toContain('### User')
    expect(content).toContain('### Assistant')
    expect(content).toContain('DONE')
    expect(content).toContain('Bash')
    expect(content).toContain('echo export-check')
    expect(content).toMatch(/completed/)
  })

  // ── 4. Export as JSON: real Save dialog, real file, valid + well-shaped ──
  test('exports the transcript as valid, well-shaped JSON', async () => {
    const jsonPath = join(exportDir, 'transcript.json')
    await stubSavePath(electronApp, jsonPath)

    const saved = await page.evaluate(
      ({ id }) => window.atelier.exportTranscript(id, 'json'),
      { id: sessionId }
    )
    expect(saved).toBe(jsonPath)

    const content = await waitForFile(jsonPath)
    const parsed = JSON.parse(content) as {
      session: { id: string; name: string; projectPath: string }
      messages: Array<{ id: number; role: string; content: unknown }>
    }

    expect(parsed.session.id).toBe(sessionId)
    expect(parsed.session.projectPath).toBe(localProjectDir)
    expect(Array.isArray(parsed.messages)).toBe(true)
    expect(parsed.messages.length).toBeGreaterThan(0)

    const hasUserText = parsed.messages.some((m) => m.role === 'user' && typeof m.content === 'string')
    expect(hasUserText).toBe(true)

    const toolCallMessage = parsed.messages.find(
      (m) =>
        m.content &&
        typeof m.content === 'object' &&
        (m.content as { kind?: string }).kind === 'tool_call' &&
        (m.content as { name?: string }).name === 'Bash'
    )
    expect(toolCallMessage, 'expected a tool_call message for the Bash invocation').toBeTruthy()
  })
})
