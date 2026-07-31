import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const lifecycleLogPath = join(artifactsDir, '02-lifecycle.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(lifecycleLogPath, '')

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

/** Stubs Electron's native folder-picker dialog to return a fixed path, so New Session can be driven headlessly. */
async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

/**
 * Runs a raw read-only SQL query against the app's real SQLite DB via the
 * `debug:queryDb` IPC channel (routed through the renderer's `page`, not a
 * fresh `new Database()` in this Node test process — better-sqlite3's
 * native binary here is compiled against Electron's ABI via
 * `@electron/rebuild`, see 00-app-shell, not plain Node's). This is the
 * direct-DB verification e2e-test-plan.md asks for ("don't just trust the
 * UI"), against the app's own live connection.
 */
async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.gardenia.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

/** Appends the main-process log's new lines (since last read) to the proof artifact and returns the full text so far. */
function appendMainLog(userDataDir: string): string {
  const logPath = join(userDataDir, 'logs', 'main.log')
  if (!existsSync(logPath)) return ''
  const contents = readFileSync(logPath, 'utf-8')
  writeFileSync(lifecycleLogPath, contents)
  return contents
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('02-session-lifecycle', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localProjectDir: string
  let localSessionId: string
  let remoteSessionId: string
  let forkedSessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-lifecycle-'))
    seedSkipOnboarding(userDataDir)
    localProjectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-project-'))
    writeFileSync(join(localProjectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Create (local) ──────────────────────────────────────────────
  test('create local: session appears in sidebar and starts streaming a real response', async () => {
    await stubProjectFolder(electronApp, localProjectDir)
    await openNewSessionModal(page)

    await page.getByTestId('pick-project-folder').click()
    await expect(page.getByTestId('pick-project-folder')).toContainText(localProjectDir)

    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()

    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    localSessionId = (await row.getAttribute('data-session-id')) as string
    expect(localSessionId).toBeTruthy()

    // Real streaming: the user prompt renders immediately, then a real
    // assistant reply streams in from the actual Claude Agent SDK call.
    await expect(page.getByTestId('transcript-message').first()).toContainText('PING')
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '02-create.png') })
  })

  // ── 2. Rename + auto-naming regression guard (Bug #93) ──────────────
  test('rename: manual name survives the auto-naming summarizer after more messages', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-rename').click()
    const input = row.getByTestId('session-rename-input')
    await input.fill('My Manual Name')
    await input.press('Enter')

    await expect(row.getByTestId('session-name')).toHaveText('My Manual Name')

    // Send a second turn — this is what triggers the manager's auto-naming
    // attempt (from turn 2 onward). The regression guard lives in
    // SessionStore.setAutoName; this proves the attempt actually happens
    // (see main.log below) and still doesn't win.
    await page.getByTestId('composer-input').fill('Reply with exactly the single word: PONG')
    await page.getByTestId('send-button').click()

    // This is the composer-driven follow-up send path (SessionManager.sendUserMessage,
    // as opposed to the initial-prompt-driven creation path in the "create local"
    // test above) — assert on the actual streamed content, not just the message
    // count, so a regression here (e.g. a silently-swallowed harness error, see
    // manager.ts's reportHarnessFailure) would be caught by a missing "PONG" rather
    // than just an assistant-message-count mismatch that could also pass via a
    // stray error message.
    //
    // Poll for the CONTENT itself, not just the row count: 03-chat-surface-core's
    // progressive-streaming model inserts an empty placeholder message the instant
    // the first text_delta arrives (so session:streamDelta has a stable id to
    // target), then fills it in over that separate channel — so the assistant
    // message count can go above 1 well before the streamed text has landed.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').allTextContents()
          return texts.some((t) => t.includes('PONG'))
        },
        { timeout: 60_000 }
      )
      .toBe(true)

    // Give the fire-and-forget auto-naming call (a full separate harness
    // turn) time to complete and attempt its write.
    await expect
      .poll(
        () => {
          const log = appendMainLog(userDataDir)
          return log.includes('auto-naming attempted but blocked')
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    // The name must NOT have been reverted.
    await expect(row.getByTestId('session-name')).toHaveText('My Manual Name')

    const rows = await queryDb<{ name: string; name_locked_by_user: number }>(
      page,
      'SELECT name, name_locked_by_user FROM sessions WHERE id = ?',
      [localSessionId]
    )
    expect(rows[0].name).toBe('My Manual Name')
    expect(rows[0].name_locked_by_user).toBe(1)
  })

  // ── 3. Close ─────────────────────────────────────────────────────────
  test('close: disappears from active view but remains in history', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    await expect(page.locator(`[data-group="pinned"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-group="ungrouped"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)).toHaveCount(1)

    appendMainLog(userDataDir)
  })

  // ── 4. Resume after a REAL app quit + relaunch ───────────────────────
  test('resume: full prior transcript renders from SQLite after a real relaunch, before live reconnect', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 15_000 })

    await historyRow.getByTestId('resume-button').click()

    // Full transcript (both turns: PING/PONG + both assistant replies) must
    // render — not just the last message — and it must come from SQLite
    // (available essentially immediately, well before a live SDK turn could
    // complete).
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(4)

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.includes('PING'))).toBe(true)
    expect(texts.some((t) => t.includes('PONG'))).toBe(true)

    await expect(page.locator(`[data-group="history"] [data-session-id="${localSessionId}"]`)).toHaveCount(0)
    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(activeRow).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '02-resume.png') })
    appendMainLog(userDataDir)
  })

  // ── 4b. Regression: an ACTIVE (never explicitly closed) session's
  // transcript must also survive a relaunch when clicked directly — not
  // just a session reopened via History's explicit "Resume" button. A
  // still-active session's transcript previously only ever lived in the
  // renderer's in-memory state, which resets on every relaunch; clicking it
  // never re-fetched from SQLite, so a real user quitting and restarting the
  // whole app (the common case, not an explicit per-session close) saw an
  // empty transcript despite the real messages being intact on disk.
  test('resume: an active (never-closed) session also reloads its transcript from SQLite after a real relaunch', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Never went through History/closed — clicking it directly is the only
    // affordance a real user has for a still-active session after relaunch.
    await row.click()

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"]').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(4)

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.includes('PING'))).toBe(true)
    expect(texts.some((t) => t.includes('PONG'))).toBe(true)
  })

  // ── 5. Fork ───────────────────────────────────────────────────────────
  test('fork: independent id, identical transcript, same group', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${localSessionId}"]`)
    const beforeIds = await page
      .locator('[data-testid="session-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-fork').click()

    await expect
      .poll(async () =>
        page.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
      )
      .not.toEqual(beforeIds)

    const allIds = await page
      .locator('[data-testid="session-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')))
    forkedSessionId = allIds.find((id) => id && id !== localSessionId) as string
    expect(forkedSessionId).toBeTruthy()
    expect(forkedSessionId).not.toBe(localSessionId)

    const sourceRows = await queryDb<{ group_id: string | null }>(page, 'SELECT group_id FROM sessions WHERE id = ?', [
      localSessionId
    ])
    const forkedRows = await queryDb<{ group_id: string | null }>(page, 'SELECT group_id FROM sessions WHERE id = ?', [
      forkedSessionId
    ])
    const sourceMessages = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? ORDER BY id',
      [localSessionId]
    )
    const forkedMessages = await queryDb<{ content: string }>(
      page,
      'SELECT content FROM messages WHERE session_id = ? ORDER BY id',
      [forkedSessionId]
    )

    expect(forkedRows[0].group_id).toBe(sourceRows[0].group_id)
    expect(forkedMessages).toEqual(sourceMessages)
    expect(forkedMessages.length).toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '02-fork.png') })
    appendMainLog(userDataDir)
  })

  // ── 6. Restart ────────────────────────────────────────────────────────
  test('restart: forks with the same name and closes the original', async () => {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${forkedSessionId}"]`)
    const nameBefore = await row.getByTestId('session-name').textContent()

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-restart').click()

    // The old (forked) session should close (move to history)...
    await expect
      .poll(async () => page.locator(`[data-group="history"] [data-session-id="${forkedSessionId}"]`).count(), {
        timeout: 10_000
      })
      .toBe(1)

    const closedRows = await queryDb<{ closed_at: string | null }>(
      page,
      'SELECT closed_at FROM sessions WHERE id = ?',
      [forkedSessionId]
    )
    const allActive = await queryDb<{ id: string; name: string }>(
      page,
      'SELECT id, name FROM sessions WHERE closed_at IS NULL AND id != ? AND id != ?',
      [localSessionId, forkedSessionId]
    )

    expect(closedRows[0].closed_at).not.toBeNull()
    const restarted = allActive.find((s) => s.name === nameBefore)
    expect(restarted).toBeTruthy()

    appendMainLog(userDataDir)
  })

  // ── 7. Delete ────────────────────────────────────────────────────────
  test('delete: sidebar entry and SQLite rows (session + messages) are both gone', async () => {
    const historyRow = page.locator(`[data-testid="session-row"][data-session-id="${forkedSessionId}"]`)
    await expect(historyRow).toBeVisible()
    await historyRow.getByTestId('session-menu-button').click()
    await historyRow.getByTestId('menu-delete').click()

    await expect(page.locator(`[data-session-id="${forkedSessionId}"]`)).toHaveCount(0)

    const sessionRows = await queryDb(page, 'SELECT id FROM sessions WHERE id = ?', [forkedSessionId])
    const messageRows = await queryDb(page, 'SELECT id FROM messages WHERE session_id = ?', [forkedSessionId])

    expect(sessionRows.length).toBe(0)
    expect(messageRows.length).toBe(0)

    appendMainLog(userDataDir)
  })

  // ── 8. Remote (real devpod) ──────────────────────────────────────────
  test('remote: creates + streams a real response executed on qingqin-go.devpod-us-or, then resumes with host re-resolved', async ({}, testInfo) => {
    // Real SSH round-trip to a devpod (two full Claude Code turns: initial +
    // post-resume) legitimately needs more than the suite's default 60s
    // budget; the 90s internal polls below would otherwise always lose a
    // race against the outer test timeout regardless of how fast SSH is.
    testInfo.setTimeout(180_000)
    await openNewSessionModal(page)
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('/home/user')
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PONGREMOTE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ id: string; hostname: string }>(
            page,
            "SELECT id, hostname FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' ORDER BY created_at DESC LIMIT 1"
          )
          return rows[0]?.id ?? null
        },
        { timeout: 15_000 }
      )
      .not.toBeNull()

    const remoteRows = await queryDb<{ id: string; hostname: string }>(
      page,
      "SELECT id, hostname FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' ORDER BY created_at DESC LIMIT 1"
    )
    remoteSessionId = remoteRows[0].id
    expect(remoteRows[0].hostname).toBe('qingqin-go.devpod-us-or')

    // Real remote execution: the response must actually come back (not a
    // silent local fallback) within a generous timeout for an SSH round-trip.
    await expect
      .poll(
        async () => {
          const messages = await page.evaluate((id) => window.gardenia.listSessionMessages(id), remoteSessionId)
          return messages.some((m) => m.role === 'assistant' && m.content.includes('PONGREMOTE'))
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    await page.screenshot({ path: join(artifactsDir, '02-remote-devpod.png') })

    // Resume: host re-resolves to the same devpod.
    const remoteRowEl = page.locator(`[data-testid="session-row"][data-session-id="${remoteSessionId}"]`)
    await remoteRowEl.getByTestId('session-menu-button').click()
    await remoteRowEl.getByTestId('menu-close').click()
    const historyRemote = page.locator(`[data-group="history"] [data-session-id="${remoteSessionId}"]`)
    await expect(historyRemote).toBeVisible({ timeout: 10_000 })
    await historyRemote.getByTestId('resume-button').click()

    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ hostname: string; closed_at: string | null }>(
            page,
            'SELECT hostname, closed_at FROM sessions WHERE id = ?',
            [remoteSessionId]
          )
          return rows[0]?.hostname === 'qingqin-go.devpod-us-or' && rows[0]?.closed_at === null
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    appendMainLog(userDataDir)
  })

  // ── 8b. Remote with a literal `~` project path (tilde-expansion bug) ───
  test('remote: project path "~" expands to $HOME on the remote host instead of breaking cd', async ({}, testInfo) => {
    // Regression test for the bug where `cd '~'` (single-quoted, so never
    // tilde-expanded by the remote shell) failed with
    // "zsh:cd:1: no such file or directory: ~". The remote-project-path
    // field is free text (see NewSessionModal), and typing a bare `~` for
    // "home directory" is completely natural — this must work.
    testInfo.setTimeout(180_000)
    await openNewSessionModal(page)
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('~')
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PONGTILDE')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    let tildeSessionId: string
    await expect
      .poll(
        async () => {
          const rows = await queryDb<{ id: string }>(
            page,
            "SELECT id FROM sessions WHERE hostname = 'qingqin-go.devpod-us-or' AND project_path = '~' ORDER BY created_at DESC LIMIT 1"
          )
          tildeSessionId = rows[0]?.id
          return tildeSessionId ?? null
        },
        { timeout: 15_000 }
      )
      .not.toBeNull()

    // Real remote execution: a real response must stream back over SSH — if
    // the old bug were present, `cd '~'` would fail before `claude` ever
    // spawns, and no assistant message (nor any response at all) would
    // arrive within this window.
    await expect
      .poll(
        async () => {
          const messages = await page.evaluate((id) => window.gardenia.listSessionMessages(id), tildeSessionId)
          return messages.some((m) => m.role === 'assistant' && m.content.includes('PONGTILDE'))
        },
        { timeout: 90_000 }
      )
      .toBe(true)

    await page.screenshot({ path: join(artifactsDir, '02-remote-tilde.png') })

    const log = appendMainLog(userDataDir)
    expect(log).not.toContain('no such file or directory: ~')

    // Clean up so it doesn't interfere with later group/index assumptions.
    const tildeRow = page.locator(`[data-testid="session-row"][data-session-id="${tildeSessionId!}"]`)
    await tildeRow.getByTestId('session-menu-button').click()
    await tildeRow.getByTestId('menu-close').click()
  })

  // ── UI-match: sidebar tokens ──────────────────────────────────────────
  test('UI-match: session dot resolves a --sc-* token, hover resolves --bg-hover', async () => {
    const dot = page.locator('[data-testid="session-dot"]').first()
    await expect(dot).toBeVisible()

    const dotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    const scTokenColors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return ['--sc-blue', '--sc-green', '--sc-purple', '--sc-amber', '--sc-rose', '--sc-cyan', '--sc-indigo', '--sc-teal'].map(
        (name) => style.getPropertyValue(name).trim()
      )
    })
    // Resolve each token name to its computed rgb() the same way the browser
    // would, then compare against the dot's actual computed background.
    const resolvedRgbs = await page.evaluate((tokens) => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      const rgbs = tokens.map((t) => {
        probe.style.backgroundColor = t
        return getComputedStyle(probe).backgroundColor
      })
      probe.remove()
      return rgbs
    }, scTokenColors)
    expect(resolvedRgbs).toContain(dotColor)

    const row = page.locator('[data-testid="session-row"]').first()
    await row.hover()
    const hoverBg = await row.evaluate((el) => getComputedStyle(el).backgroundColor)
    const bgHoverResolved = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-hover').trim()
      const rgb = getComputedStyle(probe).backgroundColor
      probe.remove()
      return rgb
    })
    expect(hoverBg).toBe(bgHoverResolved)

    await page.screenshot({ path: join(artifactsDir, '02-sidebar-ui-match.png') })
  })
})
