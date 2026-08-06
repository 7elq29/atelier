import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const orgLogPath = join(artifactsDir, '06-organization.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(orgLogPath, '')

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

/** Creates a real local claude-code session (real SDK call) with the given prompt, returns its id once it appears in the sidebar. */
async function createLocalSession(
  app: ElectronApplication,
  page: Page,
  projectDir: string,
  prompt: string
): Promise<string> {
  await stubProjectFolder(app, projectDir)
  await openNewSessionModal(page)
  await page.getByTestId('pick-project-folder').click()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('initial-prompt').fill(prompt)
  const beforeIds = await page
    .locator('[data-testid="session-row"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
  await expect
    .poll(async () =>
      page.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
    )
    .not.toEqual(beforeIds)
  const afterIds = await page
    .locator('[data-testid="session-row"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
  const newId = afterIds.find((id) => id && !beforeIds.includes(id)) as string
  expect(newId).toBeTruthy()
  return newId
}

async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.gardenia.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

function appendOrgLog(label: string, data: unknown): void {
  writeFileSync(orgLogPath, `[${label}] ${JSON.stringify(data)}\n`, { flag: 'a' })
}

function appendMainLog(userDataDir: string): string {
  const logPath = join(userDataDir, 'logs', 'main.log')
  if (!existsSync(logPath)) return ''
  return readFileSync(logPath, 'utf-8')
}

test.describe.configure({ mode: 'serial' })

test.describe('06-session-organization', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionA: string
  let sessionB: string
  let sessionC: string
  let groupId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-org-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-org-project-'))
    writeFileSync(join(projectDir, 'README.md'), '# org test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── Setup: three real sessions ────────────────────────────────────────
  test('setup: create three real sessions to organize', async () => {
    sessionA = await createLocalSession(electronApp, page, projectDir, 'Reply with exactly the single word: ALPHA')
    sessionB = await createLocalSession(electronApp, page, projectDir, 'Reply with exactly the single word: BRAVO')
    sessionC = await createLocalSession(electronApp, page, projectDir, 'Reply with exactly the single word: CHARLIE')

    // Wait for each to actually finish its first turn (status settles to
    // 'waiting') before doing anything else — avoids racing the harness.
    for (const id of [sessionA, sessionB, sessionC]) {
      await expect
        .poll(
          async () => {
            const rows = await queryDb<{ content: string }>(page, 'SELECT content FROM messages WHERE session_id = ? AND role = ?', [
              id,
              'assistant'
            ])
            return rows.length > 0
          },
          { timeout: 60_000 }
        )
        .toBe(true)
    }
    appendOrgLog('setup', { sessionA, sessionB, sessionC })
  })

  // ── Tags ────────────────────────────────────────────────────────────
  test('tags: add/remove and filter by them', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-details').click()

    const popover = row.getByTestId('session-detail-popover')
    await expect(popover).toBeVisible()
    await popover.getByTestId('tag-input').fill('urgent-fix')
    await popover.getByTestId('tag-input').press('Enter')

    await expect(popover.getByTestId('tag-pill').filter({ hasText: 'urgent-fix' })).toBeVisible()

    // Close popover by clicking elsewhere.
    await page.locator('body').click({ position: { x: 5, y: 5 } })

    // Tag pill now renders inline in the row's meta line.
    await expect(row.getByTestId('tag-pill').filter({ hasText: 'urgent-fix' })).toBeVisible()

    const tagRows = await queryDb<{ session_id: string; tag: string }>(
      page,
      'SELECT session_id, tag FROM session_tags WHERE session_id = ?',
      [sessionA]
    )
    expect(tagRows.map((r) => r.tag)).toContain('urgent-fix')

    // Filter by searching the tag text: only sessionA should remain visible
    // among the three (their names ALPHA/BRAVO/CHARLIE don't contain it).
    await page.getByTestId('sidebar-search-input').fill('urgent-fix')
    await expect(page.locator(`[data-session-id="${sessionA}"]`).first()).toBeVisible()
    await expect(page.locator(`[data-session-id="${sessionB}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-session-id="${sessionC}"]`)).toHaveCount(0)
    await page.getByTestId('sidebar-search-input').fill('')

    await page.screenshot({ path: join(artifactsDir, '06-sidebar-tags.png') })
    appendOrgLog('tags', tagRows)
  })

  // ── Fuzzy search ────────────────────────────────────────────────────
  //
  // Runs BEFORE any relaunch: quick filters below key off SessionManager's
  // in-memory `live` map (see SessionStatus's doc comment), which is
  // legitimately empty right after a real app relaunch (no session has been
  // reconnected yet) — status would read 'idle', not 'waiting', if this ran
  // after the notes/color/groups tests' relaunches.
  test('fuzzy search: matches by subsequence across session names', async () => {
    // sessionA's name auto-derives from its "Reply with exactly the single
    // word: ALPHA" prompt (deriveDefaultName truncates to 6 words + ellipsis)
    // — search a scattered subsequence of "Reply" instead of relying on the
    // exact truncated title.
    await page.getByTestId('sidebar-search-input').fill('rly')
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`)).toBeVisible()
    await page.getByTestId('sidebar-search-input').fill('zzzzz-nomatch')
    await expect(page.locator('[data-testid="session-row"][data-active="false"]')).toHaveCount(0)
    await page.getByTestId('sidebar-search-input').fill('')
  })

  // ── Quick filters ─────────────────────────────────────────────────────
  test('quick filters: Waiting and Needs attention', async () => {
    // All three sessions have finished their first turn (status 'waiting'
    // per setup) and none are terminal/closed, so the "Waiting" filter
    // should show all of them; "Needs attention" (a superset, per
    // progress.md's definition) shows them too.
    await page.getByTestId('filter-waiting').click()
    for (const id of [sessionA, sessionB, sessionC]) {
      await expect(page.locator(`[data-testid="session-row"][data-session-id="${id}"]`)).toBeVisible()
    }
    await page.getByTestId('filter-attention').click()
    for (const id of [sessionA, sessionB, sessionC]) {
      await expect(page.locator(`[data-testid="session-row"][data-session-id="${id}"]`)).toBeVisible()
    }
    await page.getByTestId('filter-all').click()
    await page.screenshot({ path: join(artifactsDir, '06-sidebar-filters.png') })
  })

  // ── Notes ─────────────────────────────────────────────────────────────
  test('notes: set a note and see it persist across relaunch', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionB}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-details').click()
    const popover = row.getByTestId('session-detail-popover')
    await popover.getByTestId('notes-textarea').fill('Follow up with the reviewer before merging.')
    await popover.getByTestId('save-notes-button').click()

    await expect
      .poll(async () => {
        const rows = await queryDb<{ notes: string | null }>(page, 'SELECT notes FROM sessions WHERE id = ?', [sessionB])
        return rows[0]?.notes
      })
      .toBe('Follow up with the reviewer before merging.')

    // Real relaunch.
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const rowAfter = page.locator(`[data-testid="session-row"][data-session-id="${sessionB}"]`)
    await expect(rowAfter).toBeVisible({ timeout: 15_000 })
    await rowAfter.getByTestId('session-menu-button').click()
    await rowAfter.getByTestId('menu-details').click()
    await expect(rowAfter.getByTestId('notes-textarea')).toHaveValue('Follow up with the reviewer before merging.')
    await page.locator('body').click({ position: { x: 5, y: 5 } })

    const dbRows = await queryDb<{ notes: string | null }>(page, 'SELECT notes FROM sessions WHERE id = ?', [sessionB])
    appendOrgLog('notes-after-relaunch', dbRows)
  })

  // ── Color ─────────────────────────────────────────────────────────────
  test('color: set a color and confirm it persists + renders via a --sc-* token', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-details').click()
    const popover = row.getByTestId('session-detail-popover')
    await popover.getByTestId('color-swatch-rose').click()

    await expect
      .poll(async () => {
        const rows = await queryDb<{ color: string | null }>(page, 'SELECT color FROM sessions WHERE id = ?', [sessionC])
        return rows[0]?.color
      })
      .toBe('--sc-rose')

    await page.locator('body').click({ position: { x: 5, y: 5 } })

    const dot = row.getByTestId('session-dot')
    const dotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    const roseResolved = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--sc-rose').trim()
      const rgb = getComputedStyle(probe).backgroundColor
      probe.remove()
      return rgb
    })
    expect(dotColor).toBe(roseResolved)

    // Real relaunch: color persists.
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    const rowAfter = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await expect(rowAfter).toBeVisible({ timeout: 15_000 })
    const dotColorAfter = await rowAfter.getByTestId('session-dot').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(dotColorAfter).toBe(roseResolved)
  })

  // ── Groups: create/rename/drag-drop/collapse ──────────────────────────
  test('groups: create, drag two sessions in, reorder, rename, collapse — all persisted', async () => {
    await page.getByTestId('new-group-button').click()
    await page.getByTestId('new-group-input').fill('Launch Week')
    await page.getByTestId('new-group-input').press('Enter')

    await expect
      .poll(async () => {
        const rows = await queryDb<{ id: string; name: string }>(page, 'SELECT id, name FROM session_groups WHERE name = ?', [
          'Launch Week'
        ])
        return rows[0]?.id ?? null
      })
      .not.toBeNull()
    const groupRows = await queryDb<{ id: string }>(page, 'SELECT id FROM session_groups WHERE name = ?', ['Launch Week'])
    groupId = groupRows[0].id

    const groupBody = page.locator(`[data-group="${groupId}"]`)

    // Drag sessionB into the new (still-empty) group's body.
    const rowB = page.locator(`[data-testid="session-row"][data-session-id="${sessionB}"]`)
    await rowB.dragTo(groupBody)

    await expect
      .poll(async () => {
        const rows = await queryDb<{ group_id: string | null }>(page, 'SELECT group_id FROM sessions WHERE id = ?', [sessionB])
        return rows[0]?.group_id
      })
      .toBe(groupId)

    // Drag sessionC into the same group, dropping it onto sessionB's row —
    // exercises the row-level reorder path (not just the header drop-zone).
    const rowBInGroup = groupBody.locator(`[data-session-id="${sessionB}"]`)
    const rowC = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await rowC.dragTo(rowBInGroup)

    await expect
      .poll(async () => {
        const rows = await queryDb<{ id: string; group_id: string | null; sort_order: number }>(
          page,
          'SELECT id, group_id, sort_order FROM sessions WHERE group_id = ? ORDER BY sort_order ASC',
          [groupId]
        )
        return rows.map((r) => r.id)
      })
      .toEqual([sessionC, sessionB])

    const orderedInDb = await queryDb<{ id: string; sort_order: number }>(
      page,
      'SELECT id, sort_order FROM sessions WHERE group_id = ? ORDER BY sort_order ASC',
      [groupId]
    )
    appendOrgLog('group-order-after-drag', orderedInDb)

    // Rename the group.
    await page.locator(`[data-testid="group-menu-button-${groupId}"]`).click()
    await page.getByTestId('group-menu-rename').click()
    await page.getByTestId('group-rename-input').fill('Launch Week (renamed)')
    await page.getByTestId('group-rename-input').press('Enter')
    await expect
      .poll(async () => {
        const rows = await queryDb<{ name: string }>(page, 'SELECT name FROM session_groups WHERE id = ?', [groupId])
        return rows[0]?.name
      })
      .toBe('Launch Week (renamed)')

    // Collapse the group.
    await page.locator(`[data-testid="group-header-${groupId}"]`).click()
    await expect(page.locator(`[data-group="${groupId}"]`)).toHaveCount(0)
    await page.locator(`[data-testid="group-header-${groupId}"]`).click() // expand back
    await expect(page.locator(`[data-group="${groupId}"]`)).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '06-sidebar-groups.png') })

    // Real relaunch: membership, order, and name all persist.
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    await expect(page.locator(`[data-testid="group-header-${groupId}"]`)).toContainText('Launch Week (renamed)', {
      timeout: 15_000
    })
    const afterRelaunch = await queryDb<{ id: string }>(
      page,
      'SELECT id FROM sessions WHERE group_id = ? ORDER BY sort_order ASC',
      [groupId]
    )
    expect(afterRelaunch.map((r) => r.id)).toEqual([sessionC, sessionB])
  })

  // ── Multi-session concurrent status ────────────────────────────────────
  test('multi-session status: a NON-active session shows live working/waiting badges during a real SDK call', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    // Focus sessionA so sessionC is definitely not the active session.
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`).click()
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`)).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)).toHaveAttribute(
      'data-active',
      'false'
    )

    // Real SDK call into sessionC — deliberately NOT the active session —
    // driven directly over the same IPC channel the composer uses.
    const sendPromise = page.evaluate(
      (id) => window.gardenia.sendSessionMessage(id, 'Count slowly to 3 out loud, then reply with exactly: DELTA'),
      sessionC
    )

    const rowC = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await expect(rowC.getByTestId('session-dot')).toHaveClass(/status-working/, { timeout: 20_000 })
    // sessionA (still the active/focused session) must be unaffected.
    await expect(
      page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`).getByTestId('session-dot')
    ).not.toHaveClass(/status-working/)

    await page.screenshot({ path: join(artifactsDir, '06-multi-session-status-working.png') })

    await sendPromise
    await expect(rowC.getByTestId('session-dot')).toHaveClass(/status-waiting/, { timeout: 60_000 })

    appendOrgLog('multi-session-status', { activeAtTimeOfCall: sessionA, workedOnInBackground: sessionC })
    appendMainLog(userDataDir)
  })

  // ── UI-match: filter chips / status badges / group headers ────────────
  test('UI-match: filter chip tokens and group-header chevron rotation', async () => {
    const chip = page.getByTestId('filter-attention')
    await chip.click()
    const activeBg = await chip.evaluate((el) => getComputedStyle(el).backgroundColor)
    const accentDimResolved = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim()
      const rgb = getComputedStyle(probe).backgroundColor
      probe.remove()
      return rgb
    })
    expect(activeBg).toBe(accentDimResolved)
    await page.getByTestId('filter-all').click()

    const header = page.locator(`[data-testid="group-header-${groupId}"]`)
    await header.click() // collapse
    const chevTransform = await header.locator('.chev').evaluate((el) => getComputedStyle(el).transform)
    expect(chevTransform).not.toBe('none')
    await header.click() // expand back

    await page.screenshot({ path: join(artifactsDir, '06-ui-match.png') })
  })

  // ── Both themes ────────────────────────────────────────────────────────
  test('screenshots: sidebar with tags/groups/filters visible in both themes', async () => {
    // Drive the real "Toggle theme" command-palette action (not a raw
    // debug IPC call) so App.tsx's actual config state — and the
    // data-theme-driven CSS custom properties this task's UI-match checks
    // depend on — genuinely updates, the same way a user would.
    async function toggleThemeViaPalette(): Promise<void> {
      await page.getByTestId('open-palette-button').click()
      await page.getByTestId('command-palette-input').fill('Toggle theme')
      await page.getByTestId('command-palette-item').first().click()
    }

    const initialTheme = await page.locator('html').getAttribute('data-theme')
    await toggleThemeViaPalette()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', initialTheme ?? '')
    await page.screenshot({ path: join(artifactsDir, `06-sidebar-organized-${initialTheme === 'dark' ? 'light' : 'dark'}.png`) })

    await toggleThemeViaPalette()
    await expect(page.locator('html')).toHaveAttribute('data-theme', initialTheme ?? '')
    await page.screenshot({ path: join(artifactsDir, `06-sidebar-organized-${initialTheme}.png`) })
  })
})
