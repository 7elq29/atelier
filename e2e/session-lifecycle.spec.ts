import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
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

  // ── Bug repro: resume replays a stale close-time SIGTERM error, and
  // there's no connect indicator during the reconnect gap ────────────────
  //
  // Root cause (per Bugs/fix-session-resume-stale-sigterm-and-no-connect-
  // indicator/spec.md): closeSession() calls harness.interrupt(), which
  // closes the SDK's internal queue and makes query()'s async iterator
  // throw. pump()'s catch block used to push an unconditional 'error' event
  // even when active.interruptRequested was already true (i.e. even though
  // this "error" is just the expected side effect of OUR OWN close) —
  // manager.ts's applyEvent persisted that as a permanent system-role
  // message, which then replays on every future resume as if the reconnect
  // itself had just failed. Separately, there was no "connecting" UI at all.
  test('bug: resume after close does not replay a stale SIGTERM error, and no connect indicator gets stuck visible', async () => {
    const bugProjectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-bug-sigterm-project-'))
    writeFileSync(join(bugProjectDir, 'README.md'), '# test project\n')

    await stubProjectFolder(electronApp, bugProjectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    // A prompt that keeps the turn actively streaming for a bit — closing
    // WHILE a turn is in flight is the path that actually makes the SDK's
    // query() iterator throw (query.interrupt() only aborts a turn that's
    // actively generating, per claude-agent-sdk-harness.ts's interrupt()
    // doc comment; closing an already-idle session ends the loop cleanly
    // with no thrown error at all — verified for real below).
    await page.getByTestId('initial-prompt').fill('Write a very long, detailed 1500-word essay about the history of gardening. Do not use any tools, just write the essay directly as your response.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Wait for the turn to actually be in flight and starting to stream real
    // content — a probe against the raw SDK (verified separately, out of
    // tree) confirmed that interrupting a query WHILE it's actively emitting
    // stream events (not before, not after 'result') is exactly what makes
    // the SDK's query() iterator throw — the precondition for pump()'s catch
    // block (claude-agent-sdk-harness.ts) to fire at all. The very first
    // assistant placeholder row appears the instant the first text_delta
    // arrives (see applyEvent's 'text_delta' case), which is the earliest
    // reliable, UI-observable proxy for "actively streaming" available here.
    await expect(page.getByTestId('composer-working-pill')).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)

    // Close via the session menu — this is the live harness.interrupt() path
    // (not a full app relaunch) that, per the bug hypothesis, writes the
    // bogus SIGTERM 'error' system message into permanent history.
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Give any async close-time teardown (interrupt()/queue-close, and — pre
    // fix — a possible bogus 'error' event) a moment to settle before
    // resuming, so the reproduction isn't racing it.
    await page.waitForTimeout(2000)

    await historyRow.getByTestId('resume-button').click()

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // Part B: a "Connecting…" indicator must show up during the reconnect
    // gap (fails on main — no such element exists at all).
    await expect(page.getByTestId('connecting-pill')).toBeVisible({ timeout: 5_000 })
    // ...and must not be stuck visible once the session is interactive again.
    await expect(page.getByTestId('connecting-pill')).toHaveCount(0, { timeout: 15_000 })

    // Part A: no bogus system-role "Error: ..." message — persisted by
    // applyEvent's `case 'error':` as `Error: ${event.message}` — should be
    // sitting in the resumed transcript as a result of OUR OWN close/
    // interrupt.
    const rowsAfterClose = await queryDb<{ role: string; content: string }>(
      page,
      "SELECT role, content FROM messages WHERE session_id = ? AND role = 'system' AND content LIKE 'Error:%'",
      [sessionId]
    )
    expect(rowsAfterClose).toEqual([])

    const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(texts.some((t) => t.startsWith('Error:'))).toBe(false)

    await page.screenshot({ path: join(artifactsDir, 'bug-session-resume-sigterm-after-resume.png') })

    // Log evidence: the real reconnect path itself must not have logged a
    // failure — confirming any visible error is stale/replayed, not a live
    // reconnect failure.
    appendMainLog(userDataDir)
    const log = readFileSync(lifecycleLogPath, 'utf-8')
    expect(log).not.toContain('"context":"reconnect"')

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()
  })

  // ── Bug repro (Part A safety net): a GENUINE reconnect failure (not our
  // own interrupt) must still surface visibly — proves the fix doesn't
  // swallow real errors along with the fake one. Deleting the project
  // directory before resume makes the real SDK subprocess spawn/run fail
  // for a real reason, unrelated to closeSession()'s interrupt.
  test('bug repro safety net: a genuine reconnect failure (not caused by our own interrupt) still surfaces an error', async () => {
    const doomedProjectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-bug-genuine-fail-'))
    writeFileSync(join(doomedProjectDir, 'README.md'), '# test project\n')

    await stubProjectFolder(electronApp, doomedProjectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: ACK')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 60_000
      })
      .toBeGreaterThan(0)

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Now genuinely break resume: the project directory the session will
    // try to reconnect with no longer exists.
    rmSync(doomedProjectDir, { recursive: true, force: true })

    await historyRow.getByTestId('resume-button').click()

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // A genuine failure must still surface as a visible system error message
    // — Part A only suppresses the bogus SIGTERM-from-our-own-interrupt case.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
          return texts.some((t) => t.toLowerCase().includes('error'))
        },
        { timeout: 20_000 }
      )
      .toBe(true)
  })

  // ── Bug repro + fix (fix-remote-resume-conversation-lost-fallback):
  // resume() against a session the CLI backend has genuinely lost all
  // record of ("No conversation found with session ID: ...") must fall back
  // ONCE to a fresh startWithId() conversation reusing the same id, with a
  // clear system message explaining why — not fail forever with a raw,
  // confusing CLI error. `everConnected` genuinely is true here (a real
  // first connection did happen) — this is deliberately NOT the "never
  // connected" case already covered by fix-no-conversation-found-remote-resume.
  //
  // Remote/devpod access (where this was actually observed in production —
  // a devpod restart pruning its own conversation history) isn't available
  // in this sandbox. The LOCAL equivalent reproduces the byte-identical
  // failure: deleting a session's own transcript `.jsonl` under
  // `~/.claude/projects/<encoded-cwd>/<id>.jsonl` after it has connected
  // once (verified for real via a standalone `claude --resume <id>` CLI
  // probe against a deleted transcript: stderr
  // "No conversation found with session ID: <id>", exit code 1 — byte-for-
  // byte the same text as the production remote log) — same "backend has no
  // record of this conversation" condition, just triggered locally instead
  // of by a remote devpod restart.
  test('bug: resume() against a conversation the CLI backend has lost falls back to a fresh session instead of failing forever', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const bugProjectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-bug-lost-conversation-'))
    writeFileSync(join(bugProjectDir, 'README.md'), '# test project\n')

    await stubProjectFolder(electronApp, bugProjectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: ACK')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Wait for the first real turn to complete — this is what flips
    // ever_connected to 1 (session_started actually fired), the precondition
    // for reconnectHarness() to route through resume() at all rather than
    // startWithId().
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)

    const everConnectedRows = await queryDb<{ ever_connected: number }>(
      page,
      'SELECT ever_connected FROM sessions WHERE id = ?',
      [sessionId]
    )
    expect(everConnectedRows[0]?.ever_connected).toBe(1)

    // Close, then delete this session's own transcript — the local
    // equivalent of the devpod losing its conversation history server-side.
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()

    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    // Mirrors historical-cost-recompute.ts's encodeProjectDir intent, but
    // verified for real (via the actual `~/.claude/projects/` dir this test
    // run just created) that Claude Code's own encoding replaces EVERY
    // non-alphanumeric character with `-` — not just `/` and `.` as
    // historical-cost-recompute.ts's comment claims. That distinction only
    // shows up here because macOS's own tmpdir() path contains `_`
    // (`/private/var/folders/xh/xxxxx_xxxx_xxxx/T/...`), which real project
    // paths essentially never do — so the narrower regex has silently never
    // been exercised by that path before.
    const encodedProjectDir = realpathSync(bugProjectDir).replace(/[^a-zA-Z0-9]/g, '-')
    const transcriptPath = join(homedir(), '.claude', 'projects', encodedProjectDir, `${sessionId}.jsonl`)
    expect(existsSync(transcriptPath)).toBe(true)
    rmSync(transcriptPath)

    await historyRow.getByTestId('resume-button').click()

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })

    // The fallback's own explanatory system message must show up (not a raw
    // "Error: Claude Code returned an error result: No conversation found
    // with session ID: ..." string) — and the session must actually recover:
    // a follow-up message gets a real new assistant response, proving the
    // fresh startWithId() conversation is genuinely usable, not just silent.
    await expect
      .poll(
        async () => {
          const texts = await page.locator('[data-testid="transcript-message"]').allTextContents()
          return texts.some((t) => t.toLowerCase().includes('lost the server-side conversation history'))
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    const textsAfterFallback = await page.locator('[data-testid="transcript-message"]').allTextContents()
    expect(textsAfterFallback.some((t) => t.includes('No conversation found'))).toBe(false)

    await page.screenshot({ path: join(artifactsDir, 'fix-remote-resume-conversation-lost-fallback-system-message.png') })

    // The fresh conversation must actually connect for real — polled, not
    // asserted immediately: the fallback's system message above is
    // persisted synchronously, well before startFreshWithRetry()'s own
    // startWithId() call has actually spawned/handshaken with the CLI (same
    // "connecting != connected yet" gap applyEvent's own doc comment
    // describes for a normal resume()). A plain existsSync() on the
    // transcript file is NOT a reliable signal here — verified for real that
    // even a FAILING `--session-id` attempt (one that goes on to hit the
    // "already in use" lock race) touches/creates the jsonl file before it
    // errors out, so that check can pass mid-retry, before any attempt has
    // actually succeeded. A second "harness event: session_started" log line
    // for this session id, though, only ever gets logged once the CLI's own
    // system/init message is genuinely received — proof of an actual
    // successful (re)connection, not just an attempt.
    await expect
      .poll(
        () => {
          appendMainLog(userDataDir)
          const currentLog = readFileSync(lifecycleLogPath, 'utf-8')
          const sessionStartedCount = currentLog
            .split('\n')
            .filter((l) => l.includes('harness event: session_started') && l.includes(sessionId)).length
          return sessionStartedCount
        },
        { timeout: 40_000 }
      )
      .toBeGreaterThanOrEqual(2)

    // Must not still be racing the fallback's own in-flight reconnect —
    // sending a follow-up while THAT is still connecting would trigger a
    // SECOND, concurrent reconnectHarness() call for the same session
    // (isActive() sees no live harness session yet), a self-inflicted
    // collision, not a real bug in the fallback itself.
    await expect(page.getByTestId('connecting-pill')).toHaveCount(0, { timeout: 15_000 })

    // The fresh conversation must have a real, usable transcript file too.
    expect(existsSync(transcriptPath)).toBe(true)

    appendMainLog(userDataDir)
    expect(readFileSync(lifecycleLogPath, 'utf-8')).toContain('resume() failed because the CLI has lost this conversation')

    // Session must be genuinely usable again: a follow-up gets a real
    // response, not another failure.
    const assistantCountBefore = await page.locator('[data-testid="transcript-message"][data-role="assistant"]').count()
    const composer = page.getByTestId('composer-input')
    await composer.fill('Reply with exactly the single word: PONG')
    await page.getByTestId('send-button').click()
    await expect
      .poll(async () => page.locator('[data-testid="transcript-message"][data-role="assistant"]').count(), {
        timeout: 30_000
      })
      .toBeGreaterThan(assistantCountBefore)

    // No infinite retry loop: only ONE fallback log line for this session,
    // not one per attempt.
    appendMainLog(userDataDir)
    const log = readFileSync(lifecycleLogPath, 'utf-8')
    const fallbackLogLines = log.split('\n').filter((l) => l.includes('resume() failed because the CLI has lost this conversation') && l.includes(sessionId))
    expect(fallbackLogLines.length).toBe(1)

    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()
  })
})
