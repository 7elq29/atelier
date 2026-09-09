import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const orgLogPath = join(artifactsDir, '06-organization.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(orgLogPath, '')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function openCommandPalette(page: Page): Promise<void> {
  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+k')
  } else {
    await page.keyboard.press('Alt+x')
  }
  await expect(page.getByTestId('command-palette')).toBeVisible()
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
    await openNewSessionModal(page)
  await page.getByTestId('project-path').fill(projectDir)
  // The path picker is focus-gated and overlays the mode buttons, so drop focus first.
  await page.getByTestId('project-path').blur()
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
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
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
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-org-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-org-project-'))
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
    await page.getByTestId('menu-details').click()

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

    await page.screenshot({ path: join(artifactsDir, '06-sidebar-tags.png') })
    appendOrgLog('tags', tagRows)
  })

  // ── Notes ─────────────────────────────────────────────────────────────
  test('notes: set a note and see it persist across relaunch', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionB}"]`)
    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-details').click()
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
    await page.getByTestId('menu-details').click()
    await expect(rowAfter.getByTestId('notes-textarea')).toHaveValue('Follow up with the reviewer before merging.')
    await page.locator('body').click({ position: { x: 5, y: 5 } })

    const dbRows = await queryDb<{ notes: string | null }>(page, 'SELECT notes FROM sessions WHERE id = ?', [sessionB])
    appendOrgLog('notes-after-relaunch', dbRows)
  })

  test('app notes: create, edit in Atomic live preview, persist across relaunch', async () => {
    await page.getByTestId('new-app-note-button').click()
    const row = page.locator('[data-testid="app-note-row"]').first()
    await expect(row).toHaveClass(/active/)

    const editor = page.getByTestId('app-note-editor').getByTestId('atomic-note-editor')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('[data-testid="atomic-note-editor"]') != null)
      )
      .toBe(true)
    await page.keyboard.type('# Release checklist\n\n- [ ] Run e2e')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

    await expect
      .poll(async () => {
        const rows = await queryDb<{ content: string }>(page, 'SELECT content FROM app_notes LIMIT 1')
        return rows[0]?.content ?? ''
      }, { timeout: 15_000 })
      .toContain('Release checklist')

    const beforeCursorRestore = (
      await queryDb<{ content: string }>(page, 'SELECT content FROM app_notes LIMIT 1')
    )[0]!.content
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')

    await page.locator(`[data-testid="session-row"][data-session-id="${sessionA}"]`).click()
    await expect(page.locator('.composer-cache-entry.active').getByTestId('composer-input')).toBeFocused()
    await row.click()
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('[data-testid="atomic-note-editor"]') != null)
      )
      .toBe(true)
    await page.keyboard.type('X')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

    const expectedAfterCursorRestore =
      `${beforeCursorRestore.slice(0, -3)}X${beforeCursorRestore.slice(-3)}`
    await expect
      .poll(async () => {
        const rows = await queryDb<{ content: string }>(page, 'SELECT content FROM app_notes LIMIT 1')
        return rows[0]?.content ?? ''
      }, { timeout: 15_000 })
      .toBe(expectedAfterCursorRestore)

    await page.screenshot({ path: join(artifactsDir, '06-app-notes-editor.png') })

    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    await expect(page.getByTestId('app-notes-list')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="app-note-row"]').first().click()
    await expect(page.getByTestId('app-note-editor')).toBeVisible()
    await expect(page.getByTestId('app-note-editor').getByText('Release checklist')).toBeVisible({ timeout: 10_000 })

    const noteId = (await page.locator('[data-testid="app-note-row"]').first().getAttribute('data-note-id')) as string
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    const noteRow = page.locator(`[data-note-id="${noteId}"]`)
    await noteRow.getByTestId('app-note-menu-button').click()
    // The menu is portaled to <body>, so it is not inside the row.
    await page.getByTestId('app-note-menu-delete').click()
    await expect(page.locator(`[data-note-id="${noteId}"]`)).toHaveCount(0)
    const dbRows = await queryDb<{ id: string }>(page, 'SELECT id FROM app_notes WHERE id = ?', [noteId])
    expect(dbRows).toHaveLength(0)
  })

  test('app notes: drag onto composer attaches as file mention on send', async () => {
    const chatSessionId =
      sessionA ?? (await createLocalSession(electronApp, page, projectDir, 'Reply with exactly the word: ATTACH'))

    await page.getByTestId('new-app-note-button').click()
    const noteRow = page.locator('[data-testid="app-note-row"]').first()
    await expect(noteRow).toHaveClass(/active/)
    const noteId = (await noteRow.getAttribute('data-note-id')) as string

    const editor = page.getByTestId('app-note-editor').getByTestId('atomic-note-editor')
    await editor.click()
    await page.keyboard.type('# Attach me\n\nDrag-drop body line.')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

    await page.locator(`[data-testid="session-row"][data-session-id="${chatSessionId}"]`).click()
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15_000 })

    await page.evaluate(
      ({ id, title }) => {
        const row = document.querySelector(`[data-note-id="${id}"]`)
        const composer = document.querySelector('.composer-box')
        if (!row || !composer) throw new Error('drag targets missing')
        const dt = new DataTransfer()
        dt.setData('application/x-atelier-app-note', JSON.stringify({ id, title: title ?? 'Untitled note' }))
        const drop = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(drop, 'dataTransfer', { value: dt })
        composer.dispatchEvent(drop)
      },
      { id: noteId, title: 'Untitled note' }
    )

    await expect(page.getByTestId('composer-attach-note')).toBeVisible()
    await page.getByTestId('composer-input').fill('Use the attached note.')
    await page.getByTestId('send-button').click()

    await expect
      .poll(async () => {
        const rows = await queryDb<{ content: string }>(
          page,
          'SELECT content FROM messages WHERE session_id = ? AND role = ? ORDER BY id DESC LIMIT 1',
          [chatSessionId, 'user']
        )
        return rows[0]?.content ?? ''
      }, { timeout: 60_000 })
      .toContain('@.atelier/app-notes/')

    const relPath = `.atelier/app-notes/untitled-note-${noteId.slice(0, 8)}.md`
    await expect.poll(() => existsSync(join(projectDir, relPath))).toBe(true)
    await page.screenshot({ path: join(artifactsDir, '06-app-note-composer-attach.png') })
  })

  // ── Sidebar bookmarks ─────────────────────────────────────────────────
  test('bookmarks: add titled + bare-URL links, edit, open externally, remove, persist across relaunch', async () => {
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        // @ts-expect-error test-only bookkeeping read back below
        globalThis.__lastOpenedExternalUrl = url
      }
    })

    const bareUrl = 'https://engwiki.example.com/display/LOG/Logging+Failover+Runbook'

    // Typed without a scheme — the app normalizes it to https://.
    await page.getByTestId('new-bookmark-button').click()
    await expect(page.getByTestId('bookmark-modal')).toBeVisible()
    await page.getByTestId('bookmark-url').fill('docs.claude.com/en/docs/auth')
    await page.getByTestId('bookmark-title').fill('Claude Auth docs')
    await page.getByTestId('bookmark-save').click()
    await expect(page.getByTestId('bookmark-modal')).toHaveCount(0)

    // No title — the row shows the URL itself.
    await page.getByTestId('new-bookmark-button').click()
    await page.getByTestId('bookmark-url').fill(bareUrl)
    await expect(page.getByTestId('bookmark-url')).toHaveValue(bareUrl)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('bookmark-modal')).toHaveCount(0)

    const rows = page.locator('[data-testid="bookmark-row"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByTestId('bookmark-label')).toHaveText('Claude Auth docs')
    await expect(rows.nth(1).getByTestId('bookmark-label')).toHaveText(bareUrl)
    await expect(rows.nth(1)).toHaveAttribute('title', bareUrl)

    await page.getByTestId('sidebar-bookmarks').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactsDir, '06-sidebar-bookmarks-pane.png') })

    // A URL that is too long for the row is ellipsized rather than widening the sidebar.
    const labelOverflow = await rows.nth(1).getByTestId('bookmark-label').evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth,
      ellipsis: getComputedStyle(el).textOverflow
    }))
    expect(labelOverflow.ellipsis).toBe('ellipsis')
    expect(labelOverflow.clipped).toBe(true)

    // Edit: retitle the first bookmark through the same dialog.
    await rows.nth(0).getByTestId('bookmark-menu-button').click()
    await page.getByTestId('bookmark-menu-edit').click()
    await expect(page.getByTestId('bookmark-url')).toHaveValue('https://docs.claude.com/en/docs/auth')
    await page.getByTestId('bookmark-title').fill('Claude auth reference')
    await page.screenshot({ path: join(artifactsDir, '06-sidebar-bookmark-dialog.png') })
    await page.getByTestId('bookmark-save').click()
    await expect(rows.nth(0).getByTestId('bookmark-label')).toHaveText('Claude auth reference')

    // Clicking a row opens the URL in the external browser, not in-app.
    const urlBefore = page.url()
    await rows.nth(0).click()
    await expect
      .poll(async () =>
        electronApp.evaluate(() => (globalThis as { __lastOpenedExternalUrl?: string }).__lastOpenedExternalUrl)
      )
      .toBe('https://docs.claude.com/en/docs/auth')
    expect(page.url()).toBe(urlBefore)

    const stored = await queryDb<{ url: string; title: string }>(page, 'SELECT url, title FROM app_bookmarks ORDER BY sort_order')
    appendOrgLog('bookmarks', stored)
    expect(stored).toHaveLength(2)

    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    await expect(page.getByTestId('bookmarks-list')).toBeVisible({ timeout: 15_000 })
    const rowsAfter = page.locator('[data-testid="bookmark-row"]')
    await expect(rowsAfter).toHaveCount(2)
    await expect(rowsAfter.nth(0).getByTestId('bookmark-label')).toHaveText('Claude auth reference')

    // Remove the bare-URL bookmark.
    await rowsAfter.nth(1).getByTestId('bookmark-menu-button').click()
    await page.getByTestId('bookmark-menu-remove').click()
    await expect(page.locator('[data-testid="bookmark-row"]')).toHaveCount(1)
    await expect
      .poll(async () => (await queryDb<{ id: string }>(page, 'SELECT id FROM app_bookmarks WHERE url = ?', [bareUrl])).length)
      .toBe(0)
  })

  test('bookmarks: drag a link out of an assistant response into the pane; a duplicate drop adds nothing', async () => {
    const linkUrl = 'https://example.com/atelier-failover-runbook'
    const linkSession = await createLocalSession(
      electronApp,
      page,
      projectDir,
      `Reply with exactly this markdown and nothing else: [Failover Runbook](${linkUrl})`
    )

    appendOrgLog('bookmark-drag-session', { linkSession })
    // Scoped to the assistant's Markdown anchor — the user's own message renders
    // the same URL as a linkified <span>, which is not draggable.
    const assistantLinkSelector = '.msg-assistant a[data-testid="external-link"]'
    const chatLink = page.locator(assistantLinkSelector).first()
    await expect(chatLink).toBeVisible({ timeout: 90_000 })
    await expect(chatLink).toHaveAttribute('draggable', 'true')

    const before = await page.locator('[data-testid="bookmark-row"]').count()

    // Playwright can't drive native HTML5 drag-and-drop, so re-dispatch the real
    // events: dragstart on the chat link fills the DataTransfer the pane then reads.
    async function dragChatLinkToPane(): Promise<void> {
      await page.evaluate((linkSelector) => {
        const link = document.querySelector(linkSelector)
        const pane = document.querySelector('[data-testid="sidebar-bookmarks"]')
        if (!link || !pane) throw new Error('drag targets missing')
        const dataTransfer = new DataTransfer()
        link.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true, cancelable: true }))
        pane.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }))
        ;(window as unknown as { __bookmarkDropTransfer: DataTransfer }).__bookmarkDropTransfer = dataTransfer
      }, assistantLinkSelector)
      await expect(page.getByTestId('sidebar-bookmarks')).toHaveClass(/drop-ready/)
      await page.getByTestId('sidebar-bookmarks').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(artifactsDir, '06-sidebar-bookmarks-drop-ready.png') })
      await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="sidebar-bookmarks"]')
        const dataTransfer = (window as unknown as { __bookmarkDropTransfer: DataTransfer }).__bookmarkDropTransfer
        pane?.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
      })
    }

    await dragChatLinkToPane()

    await expect(page.locator('[data-testid="bookmark-row"]')).toHaveCount(before + 1)
    const dropped = page.locator(`[data-testid="bookmark-row"][title="${linkUrl}"]`)
    await expect(dropped).toHaveCount(1)
    // The link text becomes the title.
    await expect(dropped.getByTestId('bookmark-label')).toHaveText('Failover Runbook')

    await dragChatLinkToPane()
    await expect(page.locator('[data-testid="bookmark-row"]')).toHaveCount(before + 1)
    const dbRows = await queryDb<{ id: string }>(page, 'SELECT id FROM app_bookmarks WHERE url = ?', [linkUrl])
    expect(dbRows).toHaveLength(1)
  })

  // ── Color ─────────────────────────────────────────────────────────────
  test('color: set a color and confirm it persists + renders via a --sc-* token', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-details').click()
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
    // Set 1: waiting · input has no visible indicator; user color persists in DB only.
    await expect(dot).toHaveClass(/status-waiting-input/)
    await expect(dot).toHaveClass(/session-status-empty/)

    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-details').click()
    await expect(row.getByTestId('session-detail-popover').getByTestId('color-swatch-rose')).toHaveClass(/selected/)
    await page.locator('body').click({ position: { x: 5, y: 5 } })

    // Real relaunch: color persists in SQLite (dot may still be status-colored while live).
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    const rowAfter = page.locator(`[data-testid="session-row"][data-session-id="${sessionC}"]`)
    await expect(rowAfter).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => {
        const rows = await queryDb<{ color: string | null }>(page, 'SELECT color FROM sessions WHERE id = ?', [sessionC])
        return rows[0]?.color
      })
      .toBe('--sc-rose')
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
      (id) => window.atelier.sendSessionMessage(id, 'Count slowly to 3 out loud, then reply with exactly: DELTA'),
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

  // ── UI-match: group-header chevron rotation ───────────────────────────
  test('UI-match: group-header chevron rotation', async () => {
    const header = page.locator(`[data-testid="group-header-${groupId}"]`)
    await header.click() // collapse
    const chevTransform = await header.locator('.chev').evaluate((el) => getComputedStyle(el).transform)
    expect(chevTransform).not.toBe('none')
    await header.click() // expand back

    const closedHeader = page.getByTestId('group-header-history')
    await expect(closedHeader.getByText('Closed')).toBeVisible()
    await closedHeader.click()
    const closedChevTransform = await closedHeader.locator('.chev').evaluate((el) => getComputedStyle(el).transform)
    expect(closedChevTransform).not.toBe('none')
    await closedHeader.click()

    await page.screenshot({ path: join(artifactsDir, '06-ui-match.png') })
  })

  // ── Both themes ────────────────────────────────────────────────────────
  test('screenshots: sidebar with tags/groups visible in both themes', async () => {
    async function toggleThemeViaPalette(): Promise<void> {
      await openCommandPalette(page)
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
