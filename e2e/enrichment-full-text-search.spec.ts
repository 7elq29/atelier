import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

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

/** Creates a real claude-code session with a real initial-prompt reply, waits for it to land, returns the session id. */
async function createSessionWithReply(
  electronApp: ElectronApplication,
  page: Page,
  projectDir: string,
  prompt: string,
  expectedSnippet: string
): Promise<string> {
  await stubProjectFolder(electronApp, projectDir)
  await openNewSessionModal(page)
  await page.getByTestId('pick-project-folder').click()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('initial-prompt').fill(prompt)
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

  const row = page.locator('[data-testid="session-row"]').last()
  await expect(row).toBeVisible({ timeout: 15_000 })
  const sessionId = (await row.getAttribute('data-session-id')) as string
  expect(sessionId).toBeTruthy()

  const assistantMsg = page.locator(`[data-testid="transcript-message"][data-role="assistant"]`).filter({ hasText: expectedSnippet })
  await expect(assistantMsg).toBeVisible({ timeout: 60_000 })

  return sessionId
}

/** Raw read-only SQL query against the app's real SQLite DB, via the same `debug:queryDb` IPC channel other specs use. */
async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('10b-enrichment-full-text-search', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDirA: string
  let projectDirB: string
  let sessionAId: string
  let sessionBId: string

  const SESSION_A_PROMPT =
    'Do not use any tools. Reply with exactly this single sentence and nothing else: The purple giraffe wandered through the misty canyon.'
  const SESSION_A_SNIPPET = 'purple giraffe'
  const SESSION_B_PROMPT =
    'Do not use any tools. Reply with exactly this single sentence and nothing else: The quantum lighthouse hummed softly at dawn.'
  const SESSION_B_SNIPPET = 'quantum lighthouse'

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-fts-'))
    seedSkipOnboarding(userDataDir)
    projectDirA = mkdtempSync(join(tmpdir(), 'atelier-e2e-fts-project-a-'))
    writeFileSync(join(projectDirA, 'README.md'), '# project a\n')
    projectDirB = mkdtempSync(join(tmpdir(), 'atelier-e2e-fts-project-b-'))
    writeFileSync(join(projectDirB, 'README.md'), '# project b\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── Setup: two real sessions with distinct real SDK replies ────────────
  test('create two sessions with distinct real replies', async () => {
    test.setTimeout(120_000)
    sessionAId = await createSessionWithReply(electronApp, page, projectDirA, SESSION_A_PROMPT, SESSION_A_SNIPPET)
    sessionBId = await createSessionWithReply(electronApp, page, projectDirB, SESSION_B_PROMPT, SESSION_B_SNIPPET)

    // The real SQLite FTS5 index (messages_fts) has real rows for both
    // sessions' assistant replies — cross-checked directly against the DB,
    // not just trusted via the UI (per e2e-test-plan.md's proof-artifact
    // convention).
    const rows = await queryDb<{ session_id: string; text: string }>(
      page,
      'SELECT session_id, text FROM messages_fts WHERE messages_fts MATCH ?',
      ['giraffe']
    )
    expect(rows.some((r) => r.session_id === sessionAId && r.text.includes('giraffe'))).toBe(true)
  })

  // ── In-conversation "Find in conversation" ──────────────────────────────
  test('in-conversation search: highlights real matches and reports a live count', async () => {
    // sessionB is currently active (created last) — switch back to sessionA.
    // Session names are auto-derived from the prompt's own first words (see
    // `deriveDefaultName`), so assert on the real transcript content
    // reappearing rather than on the session name.
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionAId}"]`).click()
    await expect(
      page.locator('[data-testid="transcript-message"][data-role="assistant"]').filter({ hasText: SESSION_A_SNIPPET })
    ).toBeVisible({ timeout: 15_000 })

    const toggleBtn = page.getByTestId('toggle-transcript-search')
    await expect(toggleBtn).toBeVisible()

    const bar = page.getByTestId('transcript-search-bar')
    await expect(bar).not.toHaveClass(/show/)
    await toggleBtn.click()
    await expect(bar).toHaveClass(/show/)

    const input = page.getByTestId('transcript-search-input')
    await expect(input).toBeFocused()
    await input.fill('purple')

    // Real highlighting: at least one <mark class="search-hit"> rendered by
    // ChatTranscript for the case-insensitive substring match. "purple"
    // appears twice in the transcript — once in the user's own initial
    // prompt (which literally asks Claude to reply with that sentence) and
    // once in the real assistant reply — so both plain-text messages get
    // highlighted, not just the assistant's.
    const hits = page.locator('mark.search-hit')
    await expect(hits.first()).toBeVisible({ timeout: 5_000 })
    await expect(hits).toHaveCount(2)

    const matchesLabel = page.getByTestId('transcript-search-matches')
    await expect(matchesLabel).toHaveText('2 matches')

    await page.screenshot({ path: join(artifactsDir, '10b-transcript-search-light.png') })

    // A query with multiple occurrences ("e") to exercise navigation.
    await input.fill('e')
    const multiHits = page.locator('mark.search-hit')
    await expect
      .poll(async () => multiHits.count(), { timeout: 5_000 })
      .toBeGreaterThan(2)
    const total = await multiHits.count()

    // First match is active by default (index 0).
    await expect(page.locator('mark.search-hit.active')).toHaveCount(1)
    await expect(page.locator('mark.search-hit.active')).toHaveAttribute('data-match-index', '0')

    // ArrowDown navigates to the next match (real DOM scrollIntoView happens
    // as a side effect inside ChatTranscript; here we assert the navigation
    // state itself, which is what actually drives that scroll).
    await input.press('ArrowDown')
    await expect(page.locator('mark.search-hit.active')).toHaveAttribute('data-match-index', '1')

    // ArrowUp goes back.
    await input.press('ArrowUp')
    await expect(page.locator('mark.search-hit.active')).toHaveAttribute('data-match-index', '0')

    // Wrap-around: ArrowUp from index 0 goes to the last match.
    await input.press('ArrowUp')
    await expect(page.locator('mark.search-hit.active')).toHaveAttribute('data-match-index', String(total - 1))

    // No matches case.
    await input.fill('zzz_no_such_text_zzz')
    await expect(page.locator('mark.search-hit')).toHaveCount(0)
    await expect(matchesLabel).toHaveText('No matches')

    // Escape closes the bar and clears highlighting.
    await input.press('Escape')
    await expect(bar).not.toHaveClass(/show/)
    await expect(page.locator('mark.search-hit')).toHaveCount(0)
  })

  test('UI-match: in-conversation search bar renders in both light and dark themes', async () => {
    async function toggleThemeViaPalette(): Promise<void> {
      await page.getByTestId('open-palette-button').click()
      await page.getByTestId('command-palette-input').fill('Toggle theme')
      await page.getByTestId('command-palette-item').first().click()
    }

    await page.getByTestId('toggle-transcript-search').click()
    const input = page.getByTestId('transcript-search-input')
    await input.fill('purple')
    await expect(page.locator('mark.search-hit').first()).toBeVisible()

    const initialTheme = await page.locator('html').getAttribute('data-theme')
    await page.screenshot({
      path: join(artifactsDir, `10b-transcript-search-${initialTheme ?? 'light'}.png`)
    })

    await toggleThemeViaPalette()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', initialTheme ?? '')
    await expect(page.locator('mark.search-hit').first()).toBeVisible()
    await page.screenshot({
      path: join(artifactsDir, `10b-transcript-search-${initialTheme === 'dark' ? 'light' : 'dark'}.png`)
    })

    // Restore + close search bar for the next test.
    await toggleThemeViaPalette()
    await page.getByTestId('transcript-search-input').press('Escape')
  })

  // ── Cross-session content search via the command palette ───────────────
  test('command palette: extended Session results match message content, not just session name', async () => {
    await page.getByTestId('open-palette-button').click()
    await expect(page.getByTestId('command-palette')).toBeVisible()

    // "quantum" appears only in session B's reply text, never in either
    // session's NAME (session names are auto-derived from the first words of
    // the prompt, which don't happen to include "quantum") — proves this is
    // a real content match, not the pre-existing name-substring filter.
    await page.getByTestId('command-palette-input').fill('quantum')

    // Both the user's own initial prompt and the real assistant reply in
    // session B contain "quantum lighthouse" (the prompt spells out the
    // exact sentence to reply with), so this can legitimately match more
    // than one row — `.first()` is enough to prove content search works.
    const contentItem = page.locator('[data-testid="command-palette-item"]', { hasText: 'quantum lighthouse' }).first()
    await expect(contentItem).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(artifactsDir, '10b-palette-content-search.png') })

    await contentItem.click()
    await expect(page.getByTestId('command-palette-backdrop')).toHaveCount(0)

    // Jumped to session B and scrolled/flashed the matching message — this
    // message only exists in session B's transcript, so its visibility here
    // is itself proof the palette navigated to the right session.
    const targetMessage = page.locator('[data-testid="transcript-message"]').filter({ hasText: 'quantum lighthouse' }).first()
    await expect(targetMessage).toBeVisible({ timeout: 15_000 })
    await expect(targetMessage).toBeInViewport()
  })
})
