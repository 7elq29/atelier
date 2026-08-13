import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

function activeComposer(page: Page) {
  return page.locator('.composer-cache-entry.active')
}


/** Real fixture project dir with a few real files on disk — no fake/fixture file list, `@file` mentions must resolve against these via the same `filesTree` IPC the Files panel (07-secondary-panels) already uses. */
function buildFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-mentions-project-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), "export function hello(): string {\n  return 'hi'\n}\n")
  writeFileSync(join(dir, 'src', 'utils.ts'), 'export const noop = (): void => {}\n')
  writeFileSync(join(dir, 'README.md'), '# fixture project\n')
  // Should be excluded from the mention list, same ALWAYS_IGNORED set the
  // Files panel's real fs walk (files.ts) already excludes.
  mkdirSync(join(dir, 'node_modules', 'ignored-pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'ignored-pkg', 'index.js'), '// should never appear in @ mentions\n')
  return dir
}

test.describe.configure({ mode: 'serial' })

test.describe('10e-enrichment-file-mentions-and-commands', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string
  let logPath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-mentions-'))
    seedSkipOnboarding(userDataDir)
    projectDir = buildFixtureProject()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    logPath = await page.evaluate(() => window.atelier.getLogFilePath())
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 0. Create a real claude-code session on the fixture project ────────
  test('setup: create session on fixture project', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
        await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible()
    await expect
      .poll(async () => {
        const n = await page.evaluate(async (dir) => {
          const entries = await window.atelier.filesList(dir)
          return entries.length
        }, projectDir)
        return n
      }, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3)
  })

  // ── 1. `@partial` opens a popover of REAL matching files ────────────────
  test('@ mention popover lists real files under projectPath, filtered live', async () => {
    const composer = activeComposer(page)
    const textarea = composer.getByTestId('composer-input')
    await textarea.fill('@inde')

    const popover = composer.getByTestId('mention-popover')
    await expect(popover).toBeVisible()
    const items = composer.getByTestId('mention-item')
    await expect(items).toHaveCount(1)
    expect(await items.first().getAttribute('data-path')).toBe('src/index.ts')
    await expect(items.first()).toContainText('index.ts')
    await expect(items.first()).toContainText('src/index.ts')

    // node_modules must never surface, same as the Files panel's own walk.
    await expect(composer.getByTestId('mention-item').filter({ hasText: 'ignored-pkg' })).toHaveCount(0)

    await page.screenshot({ path: join(artifactsDir, '10e-file-mention-popover.png') })

    // ── 2. Keyboard select inserts the real relative path at the cursor ──
    await textarea.press('Enter')
    await expect(popover).toHaveCount(0)
    await expect(textarea).toHaveValue('@src/index.ts ')
  })

  // ── 3. Broader query still filters correctly (substring match) ─────────
  test('@ mention popover filters live as more characters are typed', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.fill('')
    await textarea.click()
    await textarea.type('@ut')

    const items = page.getByTestId('mention-item')
    await expect(items).toHaveCount(1)
    expect(await items.first().getAttribute('data-path')).toBe('src/utils.ts')

    // Narrow further to something matching nothing real -> popover closes.
    await textarea.type('terlynonexistent')
    await expect(page.getByTestId('mention-popover')).toHaveCount(0)

    await textarea.fill('')
  })

  // ── 4. `/` at the start opens the real slash-command popover ───────────
  test('slash command popover lists registered commands, keyboard nav works', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()
    await textarea.type('/')

    const popover = page.getByTestId('slash-popover')
    await expect(popover).toBeVisible()
    const items = page.getByTestId('slash-item')
    // Local, Atelier-only commands (bug #56) always come first, in this
    // fixed order, since Composer.tsx merges `[...local, ...live]`.
    // Anything AFTER them is the harness's LIVE SDK command registry
    // (`liveSlashCommands`, sourced from `query.initializationResult()` /
    // `commands_changed`) — its exact contents can vary by installed SDK
    // version and which skills/plugins are discovered, so this only pins
    // the local prefix and a lower bound on total count, not an exact list.
    const commands = await items.evaluateAll((els) => els.map((el) => el.getAttribute('data-command')))
    expect(commands.slice(0, 4)).toEqual(['/clear', '/interrupt', '/fork', '/model'])
    expect(commands.length).toBeGreaterThanOrEqual(4)

    await page.screenshot({ path: join(artifactsDir, '10e-slash-command-popover.png') })

    // Arrow-down three times to reach /model (now at index 3).
    await textarea.press('ArrowDown')
    await textarea.press('ArrowDown')
    await textarea.press('ArrowDown')
    await expect(items.nth(3)).toHaveClass(/selected/)

    // Escape dismisses without running anything.
    await textarea.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(textarea).toHaveValue('/')

    // Refocus with `/` still in the buffer — popover should return without retyping.
    await textarea.click()
    await expect(popover).toBeVisible()

    await textarea.fill('')
  })

  // ── 4b. The live registry actually came from the SDK, not a re-hardcoded
  // 4th/5th client array — proven by grepping the main-process log for the
  // `commands_updated` harness event this session's real `query.
  // initializationResult()` call produced (bug #56).
  test('live slash-command list is sourced from the real SDK registry (log evidence)', async () => {
    await expect
      .poll(
        () => {
          const raw = readFileSync(logPath, 'utf-8')
          return raw
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .some((e) => e.msg === 'harness event: commands_updated' && e.sessionId === sessionId)
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  })

  // ── 5. Selecting a slash command runs a REAL action: /clear ────────────
  test('/clear selection clears the composer for real', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()
    await textarea.type('/cle')
    await expect(page.getByTestId('slash-popover')).toBeVisible()
    await textarea.press('Enter')
    await expect(page.getByTestId('slash-popover')).toHaveCount(0)
    await expect(textarea).toHaveValue('')
  })

  // ── 6. Selecting /fork runs the REAL fork action (new session appears) ──
  test('/fork selection forks the real session', async ({}, testInfo) => {
    testInfo.setTimeout(30_000)
    const rowsBefore = await page.locator('[data-testid="session-row"]').count()

    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()
    await textarea.type('/fork')
    const popover = page.getByTestId('slash-popover')
    await expect(popover).toBeVisible()
    await textarea.press('Enter')
    await expect(popover).toHaveCount(0)
    // The token is consumed, not sent as literal text.
    await expect(textarea).toHaveValue('')

    // Real, observable effect: a new session row shows up in the sidebar,
    // and the DB actually has a second session row forked from the first.
    await expect
      .poll(async () => page.locator('[data-testid="session-row"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(rowsBefore)

    const sessionRows = await page.evaluate(() =>
      window.atelier.debugQueryDb<{ id: string; project_path: string }>('SELECT id, project_path FROM sessions', [])
    )
    const forkedRow = sessionRows.find((r) => r.id !== sessionId)
    expect(forkedRow).toBeTruthy()
    expect(forkedRow?.project_path).toBe(projectDir)
  })
})
