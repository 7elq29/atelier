import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const chatLogPath = join(artifactsDir, '03-chat.log')

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

/**
 * Appends every `session:message` / `session:streamDelta` event this test
 * has observed (via the renderer's own IPC listeners, re-forwarded to
 * console) into the proof-artifact log. We hook this by polling the DB
 * `messages` table content instead, since that's simpler and equally
 * faithful (every event this task cares about — text_delta accumulation,
 * tool_call_start/end, todo_update, compaction — ends up as a message row,
 * per SessionManager.applyEvent).
 */
async function logTranscriptState(page: Page, sessionId: string, label: string): Promise<void> {
  const rows = await page.evaluate(
    (id) => window.gardenia.debugQueryDb<{ role: string; content: string; created_at: string }>(
      'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC',
      [id]
    ),
    sessionId
  )
  const lines = rows.map((r) => `[${label}] ${r.role}: ${r.content.slice(0, 200)}`)
  writeFileSync(chatLogPath, lines.join('\n') + '\n', { flag: 'a' })
}

test.describe.configure({ mode: 'serial' })

test.describe('03-chat-surface-core', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string

  test.beforeAll(async () => {
    writeFileSync(chatLogPath, '')
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-chat-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-chat-project-'))
    writeFileSync(join(projectDir, 'a.txt'), 'a\n')
    writeFileSync(join(projectDir, 'b.txt'), 'b\n')
    writeFileSync(join(projectDir, 'c.txt'), 'c\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Create + progressive streaming + tool-call lifecycle ─────────────
  test('create session: assistant text streams progressively and a tool-call card runs then completes', async () => {
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the Bash tool to run exactly: sleep 2 && echo done. Wait for it to finish, then reply with three full sentences describing what the command did.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // The user's own message renders immediately, with no border (see the
    // UI-match test below for the assertion on computed style).
    await expect(page.getByTestId('transcript-message').first()).toContainText('sleep 2')

    // Tool-call card: must appear, show the RUNNING (pulsing) indicator
    // first (the `sleep 2` gives a real ~2s window to observe this before
    // it flips), then flip to a completed status chip.
    const toolCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    await expect(toolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(artifactsDir, '03-tool-card-running.png') })

    await expect(toolCard.locator('[data-testid="tool-status-chip"]')).toHaveText('completed', { timeout: 30_000 })
    await page.screenshot({ path: join(artifactsDir, '03-tool-card-completed.png') })

    // Expanding shows real (non-empty) input/output.
    await toolCard.click()
    await expect(toolCard).toHaveClass(/open/)
    const inputText = await toolCard.locator('[data-testid="tool-input"]').textContent()
    const outputText = await toolCard.locator('[data-testid="tool-output"]').textContent()
    expect(inputText).toContain('sleep 2')
    expect(outputText?.trim().length ?? 0).toBeGreaterThan(0)
    expect(outputText).toContain('done')

    // Progressive streaming proof: capture the assistant reply's DOM content
    // at two points ~300ms apart while it's still streaming in, and assert
    // they differ (token-level rendering, not a single final paint). The
    // assistant reply starts only after the tool call completes, so poll
    // for the assistant bubble to appear, then race the two snapshots.
    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').first()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })
    const snap1 = await assistantMsg.textContent()
    await page.screenshot({ path: join(artifactsDir, '03-stream-progress-1.png') })
    await page.waitForTimeout(300)
    const snap2 = await assistantMsg.textContent()
    await page.screenshot({ path: join(artifactsDir, '03-stream-progress-2.png') })

    // Wait for the turn to actually finish before asserting anything further.
    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(
            (id) => window.gardenia.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%'",
              [id]
            ),
            sessionId
          )
          return rows[0]?.c ?? 0
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    expect(snap1).not.toBe(snap2)
    expect((snap2?.length ?? 0)).toBeGreaterThanOrEqual(snap1?.length ?? 0)

    await logTranscriptState(page, sessionId, 'turn1')
  })

  // ── 2. Todo rail: live checklist from an explicit TodoWrite ─────────────
  test('todo rail renders and updates live from TodoWrite', async () => {
    await page.getByTestId('composer-input').fill(
      'Use the TodoWrite tool now to create a todo list with exactly two items: "Step one" and "Step two". ' +
        'First call TodoWrite with "Step one" as in_progress and "Step two" as pending. ' +
        'Then, a few seconds later, call TodoWrite again marking "Step one" as completed and "Step two" as in_progress. ' +
        'Do not use any other tools. Then reply with a one-sentence summary.'
    )
    await page.getByTestId('send-button').click()

    const todoCard = page.getByTestId('todo-tracker-card')
    await expect(todoCard).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('todo-item')).toHaveCount(2, { timeout: 30_000 })

    // Live update: eventually one item flips to done (checked via the box
    // fill / strikethrough class, matching .todo-item.done in the mock).
    await expect
      .poll(
        async () => page.locator('.todo-item.done').count(),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '03-todo-rail.png') })
    await logTranscriptState(page, sessionId, 'turn2-todos')
  })

  // ── 3. Turn divider shows elapsed time ───────────────────────────────────
  test('turn divider shows elapsed time between turns', async () => {
    const divider = page.locator('[data-testid="turn-divider"]').first()
    await expect(divider).toBeVisible()
    const text = (await divider.textContent())?.trim() ?? ''
    expect(text).toMatch(/^\d+(h \d+m|m \d+s|s)$/)
    await page.screenshot({ path: join(artifactsDir, '03-turn-divider.png') })
  })

  // ── 4. Subagent nesting: a spawned Task's own tool calls render nested ──
  test('subagent tool calls render nested under the parent Task card', async () => {
    await page.getByTestId('composer-input').fill(
      'Use the Task tool to spawn exactly one general-purpose subagent. Give it this exact instruction: ' +
        '"Use the Bash tool to run: ls *.txt | wc -l — then reply with ONLY that number." ' +
        'Wait for the subagent to report back, then tell me the number it found in one sentence. Use the Task tool for this, do not run ls yourself.'
    )
    await page.getByTestId('send-button').click()

    // The subagent-spawning tool is named "Task" per the Agent SDK's own
    // docs, but this Uber-internal Claude Code build actually calls it
    // "Agent" (verified for real via a live run) — match either.
    const taskCard = page
      .locator('[data-testid="tool-card"][data-tool-name="Task"], [data-testid="tool-card"][data-tool-name="Agent"]')
      .first()
    await expect(taskCard).toBeVisible({ timeout: 30_000 })

    const wrap = page.locator(`[data-testid="subagent-wrap"][data-parent-tool-use-id="${await taskCard.getAttribute('data-tool-use-id')}"]`)
    await expect(wrap).toBeVisible({ timeout: 60_000 })
    const nestedCards = wrap.locator('[data-testid="tool-card"]')
    await expect(nestedCards.first()).toBeVisible({ timeout: 30_000 })
    expect(await nestedCards.count()).toBeGreaterThan(0)

    // Scroll the parent Task/Agent card + its nested subagent-wrap into view
    // together (not just the wrap alone) so a screenshot actually shows the
    // nesting relationship, not just an isolated card — the whole reason a
    // human reviewer needs this shot instead of trusting the DOM assertion
    // above (see the 09-obsidian Timeline bug this project already hit once
    // from reviewing prose/DOM-only instead of the actual rendered pixels).
    await taskCard.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactsDir, '03-subagent-nesting-visible.png'), fullPage: true })

    // The nested card must NOT also appear as a top-level sibling of the
    // Task card (i.e. not flattened into the main list) — every tool-card
    // whose parent-tool-use-id equals the Task's id must live inside the
    // wrap, not outside it.
    const nestedToolUseIds = await nestedCards.evaluateAll((els) => els.map((el) => el.getAttribute('data-tool-use-id')))
    for (const id of nestedToolUseIds) {
      const outsideCount = await page
        .locator(`.transcript > [data-testid="tool-card"][data-tool-use-id="${id}"]`)
        .count()
      expect(outsideCount).toBe(0)
    }

    await page.screenshot({ path: join(artifactsDir, '03-subagent-nesting.png') })

    await expect
      .poll(
        async () => taskCard.getAttribute('data-tool-status'),
        { timeout: 90_000 }
      )
      .toBe('completed')

    await logTranscriptState(page, sessionId, 'turn3-subagent')
  })

  // ── 5. UI-match: bubbles, tool card, divider, rail — both themes ────────
  test('UI-match: user bubble has no border, tool card resolves --bg-tint/--accent tokens', async () => {
    async function resolveToken(name: string): Promise<string> {
      return page.evaluate((tokenName) => {
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim()
        const rgb = getComputedStyle(probe).backgroundColor
        probe.remove()
        return rgb
      }, name)
    }
    async function resolveTokenAsBorderColor(name: string): Promise<string> {
      return page.evaluate((tokenName) => {
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        probe.style.borderColor = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim()
        const rgb = getComputedStyle(probe).borderColor
        probe.remove()
        return rgb
      }, name)
    }

    // Light theme first.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    const userMsg = page.locator('.msg-user').first()
    await expect(userMsg).toBeVisible()
    const userBorder = await userMsg.evaluate((el) => getComputedStyle(el).borderStyle)
    expect(userBorder).toBe('none')
    const userBorderWidth = await userMsg.evaluate((el) => getComputedStyle(el).borderWidth)
    expect(userBorderWidth).toBe('0px')

    const toolCard = page.locator('[data-testid="tool-card"]').first()
    await expect(toolCard).toBeVisible()
    const toolBg = await toolCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    const toolLeftBorderColor = await toolCard.evaluate((el) => getComputedStyle(el).borderLeftColor)
    expect(toolBg).toBe(await resolveToken('--bg-tint'))
    expect(toolLeftBorderColor).toBe(await resolveTokenAsBorderColor('--accent'))

    await page.screenshot({ path: join(artifactsDir, '03-ui-match-light.png'), fullPage: true })

    // Dark theme.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    const userBorderDark = await userMsg.evaluate((el) => getComputedStyle(el).borderStyle)
    expect(userBorderDark).toBe('none')
    const toolBgDark = await toolCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(toolBgDark).toBe(await resolveToken('--bg-tint'))
    // Dark and light --bg-tint values are genuinely different tokens (see
    // shared.css) — confirms this isn't a hardcoded color, it really tracks
    // the token per theme.
    expect(toolBgDark).not.toBe(toolBg)

    await page.screenshot({ path: join(artifactsDir, '03-ui-match-dark.png'), fullPage: true })

    // Restore to light for any later tests / consistency of remaining artifacts.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  })
})
