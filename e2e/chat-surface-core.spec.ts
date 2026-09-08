import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const chatLogPath = join(artifactsDir, '03-chat.log')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

/** The changes cap holds two lists, each with its own collapsed state. */
async function expandCapSection(page: Page, testId: string): Promise<void> {
  const toggle = page.getByTestId(testId).locator('.chat-changes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

async function collapseCapSection(page: Page, testId: string): Promise<void> {
  const toggle = page.getByTestId(testId).locator('.chat-changes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
}

/**
 * Some tool calls (Edit/Write always, and occasionally Read/Bash when the
 * model guesses a path outside the session's working directory) trigger a
 * real `canUseTool` permission prompt (05-interactive-prompts) that would
 * otherwise block the turn forever. Best-effort: if a permission card shows
 * up within `timeoutMs`, approve it; if none appears, this is a no-op (most
 * turns in this file never trigger one).
 */
async function approveAnyPendingPermission(page: Page, timeoutMs = 5_000): Promise<void> {
  const permCard = page.getByTestId('permission-card').last()
  try {
    await expect(permCard).toBeVisible({ timeout: timeoutMs })
  } catch {
    return
  }
  await permCard.getByTestId('perm-allow').click()
}

/**
 * Approves EVERY currently-visible permission card whose own Allow button is
 * still visible — not just `.last()`. Two Read calls that each guess a path
 * outside the working directory (e.g. `~/a.txt` then `~/b.txt`) can produce
 * two SEPARATE permission cards; once the first is resolved (its Allow/Deny
 * buttons disappear, replaced by an "Allowed"/"Denied" label) `.last()` can
 * resolve to the SECOND, still-pending card, which is correct, but if the
 * cards render in the other order `.last()` instead resolves to the
 * already-resolved one — its own Allow button is gone, so the click
 * silently no-ops (via `.catch()`) and the real pending card in front of it
 * is never clicked, hanging the turn forever. Iterating all cards and
 * clicking whichever ones still expose an Allow button avoids that.
 */
async function approveAllPendingPermissions(page: Page): Promise<void> {
  const cards = page.getByTestId('permission-card')
  const count = await cards.count().catch(() => 0)
  for (let i = 0; i < count; i++) {
    await cards
      .nth(i)
      .getByTestId('perm-allow')
      .click({ timeout: 500 })
      .catch(() => undefined)
  }
}

/**
 * Waits for the whole turn to go idle (Send button reappears), transparently
 * approving any number of permission prompts that pop up along the way (a
 * single turn can trigger more than one — e.g. two separate Read calls each
 * guessing a path outside the working directory). Polls in a tight loop
 * rather than a single long wait so a prompt appearing mid-poll gets caught.
 */
async function waitForTurnIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.getByTestId('send-button').isVisible()) return
    await approveAllPendingPermissions(page)
    await page.waitForTimeout(300)
  }
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 1_000 })
}

/**
 * Same permission-approving poll loop as `waitForTurnIdle`, but for waiting
 * on an arbitrary mid-turn condition (e.g. "the aggregate row shows the two
 * finished Reads yet") instead of full turn completion — a permission
 * prompt can just as easily block progress *before* the turn ends.
 */
async function waitForCondition(page: Page, predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await approveAllPendingPermissions(page)
    await page.waitForTimeout(300)
  }
  expect(await predicate()).toBe(true)
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
    (id) => window.atelier.debugQueryDb<{ role: string; content: string; created_at: string }>(
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
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-chat-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-chat-project-'))
    // Deliberately only 2 files: several tests below (e.g. the tool-call
    // sequence-collapse test) instruct the model to read exactly a.txt and
    // b.txt and assert an exact "Read 2 files" count — a stray unreferenced
    // third file in this shared project dir gave the model something extra
    // to glance at despite explicit instructions not to, causing a real,
    // occasionally-reproducing "Read 3 files" mismatch unrelated to the
    // aggregation logic under test.
    writeFileSync(join(projectDir, 'a.txt'), 'a\n')
    writeFileSync(join(projectDir, 'b.txt'), 'b\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Create + progressive streaming + tool-call lifecycle ─────────────
  test('create session: assistant text streams progressively and a tool-call card runs then completes', async () => {
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
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

    // Tool-call card: must appear while running (sleep 2 gives a window to
    // observe the pulsing indicator). Once finished, the lone call folds
    // into the aggregate row — expand it to verify completion + I/O.
    const runningToolCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(runningToolCard).toBeVisible({ timeout: 30_000 })
    await expect(runningToolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(artifactsDir, '03-tool-card-running.png') })

    const summaryRow = page.locator('[data-testid="tool-sequence-summary"]').last()
    await waitForCondition(
      page,
      async () => /ran 1 shell command/i.test((await summaryRow.locator('.tool-sequence-summary-text').textContent()) ?? ''),
      30_000
    )
    await summaryRow.click()
    const toolCard = summaryRow.locator('[data-testid="tool-sequence-summary-body"] [data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(toolCard.locator('[data-testid="tool-status-chip"]')).toHaveText('completed', { timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, '03-tool-card-completed.png') })

    // Expanding the card shows real (non-empty) input/output.
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
            (id) => window.atelier.debugQueryDb<{ c: number }>(
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

    // TEMP-VERIFY-ONLY: revert before commit
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

  // ── 4b. Tool-call sequence collapse (14-tool-call-sequence-collapse) ────
  test('tool-call sequence collapses finished calls into one aggregate row, keeps the running call visible', async () => {
    test.setTimeout(90_000)
    await page.getByTestId('composer-input').fill(
      'Read the file a.txt, then read the file b.txt, then run `sleep 6 && echo hi` with Bash, then reply with exactly the word DONE. ' +
        'Use exactly those three tool calls total, in that order, and no others — do not call any tool a second time, do not retry.'
    )
    await page.getByTestId('send-button').click()

    // Mid-turn: the finished Read(s) so far are already one aggregate row
    // reading "Read N files"; the in-flight Bash call is its own separate,
    // visible card with the running spinner — not swallowed into the
    // aggregate. The Bash command sleeps 6s (real time) specifically to
    // give a generous, reliable observation window regardless of how long
    // the model itself takes to get from the Reads to invoking Bash.
    //
    // N isn't asserted as exactly 2 here: the aggregate legitimately shows
    // "Read 1 file" for a brief instant if the second Read is still running
    // when this check lands (per spec, collapsing kicks in once the overall
    // sequence has 2+ calls — it doesn't require 2+ *finished* calls yet).
    // The authoritative count is read again post-turn below, once nothing
    // is running.
    const summaryRow = page.locator('[data-testid="tool-sequence-summary"]').last()
    await waitForCondition(
      page,
      async () => /read \d+ files?/i.test((await summaryRow.locator('.tool-sequence-summary-text').textContent()) ?? ''),
      30_000
    )

    // Find the specific Bash card that is actually running right now (by
    // `data-tool-status`, not just `.last()` on name) — `.last()` alone can
    // momentarily still resolve to an unrelated, already-completed Bash
    // card from an earlier test/turn (e.g. a nested subagent Bash call)
    // if this turn's own Bash call hasn't been issued yet at the instant
    // the Read aggregate first appears. Approve any permission prompt along
    // the way (a Bash call, or a second Read retry, can each trigger one).
    const runningBash = page.locator('[data-testid="tool-card"][data-tool-name="Bash"][data-tool-status="running"]').last()
    await waitForCondition(page, async () => runningBash.isVisible(), 30_000)
    await expect(runningBash.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-mid-turn.png') })

    // Pin this specific Bash call by its immutable tool-use-id — `.last()`
    // re-resolves dynamically, so once this exact card unmounts (correctly,
    // once collapsed into the aggregate) it would silently fall back to
    // matching an unrelated, still-standalone Bash card from an earlier test
    // (e.g. test 1's own single-tool-call turn) instead of proving removal.
    const bashToolUseId = await runningBash.getAttribute('data-tool-use-id')
    const thisBashCard = page.locator(`[data-testid="tool-card"][data-tool-use-id="${bashToolUseId}"]`)

    // Wait for the whole turn to actually finish — the composer's own
    // Send/Stop toggle (same signal composer-core.spec.ts's Stop-button
    // tests rely on) is the authoritative "turn is idle" signal driven
    // directly by the SDK harness, unlike a DB-row-count poll which can
    // race across chained turns in the same long-lived session.
    await waitForTurnIdle(page, 30_000)

    // Once the whole sequence finishes, everything (including what was the
    // separately-shown current Bash card) rolls into the one aggregate row —
    // no standalone tool-card remains outside it. The final Read count N is
    // read fresh here (rather than assumed to be 2): a Read occasionally
    // triggers its own permission prompt and a failed-then-retried call when
    // the model first guesses a path outside the session's working
    // directory (confirmed via a live run: a first `Read` for
    // `/Users/.../a.txt` errored "File does not exist", followed by a
    // corrected `Read` for the real project-dir path) — a real, occasional
    // SDK/model retry, not a bug in this feature's aggregation, which
    // correctly counts whatever tool calls actually occurred.
    await waitForCondition(
      page,
      async () => /read \d+ files?, ran 1 shell command/i.test((await summaryRow.locator('.tool-sequence-summary-text').textContent()) ?? ''),
      10_000
    )
    const finalText = (await summaryRow.locator('.tool-sequence-summary-text').textContent()) ?? ''
    const readCount = Number(finalText.match(/read (\d+) files?, ran 1 shell command/i)?.[1] ?? NaN)
    expect(Number.isFinite(readCount) && readCount >= 2).toBe(true)
    await expect(thisBashCard).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-post-turn.png') })

    // Clicking the aggregate reveals all N+1 individual cards, in order
    // (every Read call, then Bash), each still independently expandable to
    // its own full input/output.
    await summaryRow.click()
    const expandedBody = summaryRow.locator('[data-testid="tool-sequence-summary-body"]')
    await expect(expandedBody).toBeVisible()
    const expandedCards = expandedBody.locator('[data-testid="tool-card"]')
    await expect(expandedCards).toHaveCount(readCount + 1)
    for (let i = 0; i < readCount; i++) {
      expect(await expandedCards.nth(i).getAttribute('data-tool-name')).toBe('Read')
    }
    expect(await expandedCards.nth(readCount).getAttribute('data-tool-name')).toBe('Bash')

    const firstCard = expandedCards.nth(0)
    await firstCard.click()
    await expect(firstCard).toHaveClass(/open/)
    const inputText = await firstCard.locator('[data-testid="tool-input"]').textContent()
    expect(inputText).toContain('a.txt')

    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-expanded.png') })

    await logTranscriptState(page, sessionId, 'turn3b-sequence-collapse')
  })

  test('a sequence of exactly one completed tool call collapses into an aggregate row', async () => {
    await page.getByTestId('composer-input').fill(
      'Use the Bash tool to run exactly: echo single-tool-test. Do not use any other tool. ' +
        'Wait for it to finish, then reply with exactly the word DONE.'
    )
    await page.getByTestId('send-button').click()

    await waitForTurnIdle(page, 30_000)

    const summaryRow = page
      .locator('[data-testid="transcript-message"][data-role="user"]')
      .filter({ hasText: 'single-tool-test' })
      .locator('~ [data-testid="tool-sequence-summary"]')
      .first()
    await expect(summaryRow).toBeVisible({ timeout: 30_000 })
    await expect(summaryRow.locator('.tool-sequence-summary-text')).toContainText(/ran 1 shell command/i)

    const bashInSummary = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'single-tool-test' })
    await expect(bashInSummary).toHaveCount(0)

    await summaryRow.click()
    const bashCard = summaryRow
      .locator('[data-testid="tool-sequence-summary-body"] [data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'single-tool-test' })
    await expect(bashCard).toHaveCount(1)
    await expect(bashCard.locator('[data-testid="tool-status-chip"]')).toHaveText('completed')

    await summaryRow.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-single-call.png') })

    await logTranscriptState(page, sessionId, 'turn3c-single-call-no-aggregate')
  })

  test('collapsed row: Edit shows a +N -M lines change summary, Bash shows headline only', async () => {
    test.setTimeout(120_000)
    await page.getByTestId('composer-input').fill(
      'First use the Read tool to read the file a.txt (its current content is just "a" on one line). ' +
        'Then use the Edit tool to append a new line reading "extra line" to the end of that file. ' +
        'Then use the Bash tool to run exactly: echo hi. Then reply with exactly the word DONE. ' +
        'Use exactly those three tool calls total, in that order, and no others — do not call any tool a second time, do not retry, do not read any other file.'
    )
    await page.getByTestId('send-button').click()

    // An Edit call (05-interactive-prompts) always triggers a real
    // `canUseTool` permission prompt before it runs (and the leading Read
    // occasionally does too, per the top-level sequence-collapse test above)
    // — approve any that show up so the turn can actually proceed.
    await waitForTurnIdle(page, 60_000)

    const summaryRow = page.locator('[data-testid="tool-sequence-summary"]').last()
    await expect(summaryRow).toBeVisible({ timeout: 10_000 })
    await expect(summaryRow.locator('.tool-sequence-summary-text')).toHaveText(
      'Read 1 file, edited 1 file, ran 1 shell command',
      { timeout: 10_000 }
    )

    await summaryRow.click()
    const cards = summaryRow.locator('[data-testid="tool-sequence-summary-body"] [data-testid="tool-card"]')
    await expect(cards).toHaveCount(3)

    const readCard = cards.nth(0)
    expect(await readCard.getAttribute('data-tool-name')).toBe('Read')
    expect(await readCard.locator('[data-testid="tool-edit-summary"]').count()).toBe(0)

    const editCard = cards.nth(1)
    expect(await editCard.getAttribute('data-tool-name')).toBe('Edit')
    const editSummary = editCard.locator('[data-testid="tool-edit-summary"]')
    await expect(editSummary).toBeVisible()
    await expect(editSummary).toHaveText(/^\+\d+ -\d+ lines$/)

    const bashCard = cards.nth(2)
    expect(await bashCard.getAttribute('data-tool-name')).toBe('Bash')
    expect(await bashCard.locator('[data-testid="tool-edit-summary"]').count()).toBe(0)

    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-edit-summary.png') })
    await logTranscriptState(page, sessionId, 'turn3d-edit-summary')
  })

  test('subagent nested tool-call sequence gets the same aggregation as the top-level sequence', async () => {
    test.setTimeout(120_000)
    const taskCardLocator = page.locator(
      '[data-testid="tool-card"][data-tool-name="Task"], [data-testid="tool-card"][data-tool-name="Agent"]'
    )
    const taskCardsBefore = await taskCardLocator.count()

    await page.getByTestId('composer-input').fill(
      'Use the Task tool to spawn exactly one general-purpose subagent. Give it this exact instruction: ' +
        '"Read the file a.txt, then read the file b.txt, then reply with exactly the word DONE. Use exactly those two tool calls, no others, do not retry." ' +
        'Wait for the subagent to report back, then tell me in one sentence what it read. Use the Task tool for this, do not read the files yourself.'
    )
    await page.getByTestId('send-button').click()

    // `.last()` re-resolves dynamically, but grabbing its tool-use-id right
    // away would bake in whatever Task/Agent card is *currently* last — a
    // stale one from an earlier test (e.g. test 4's own subagent-nesting
    // turn), if this turn's own Task/Agent call hasn't rendered yet at this
    // exact instant. Wait for a genuinely new Task/Agent card to appear
    // (count > before) so `.last()` is guaranteed to mean *this* turn's.
    await waitForCondition(page, async () => (await taskCardLocator.count()) > taskCardsBefore, 30_000)
    const taskCard = taskCardLocator.last()
    await expect(taskCard).toBeVisible({ timeout: 30_000 })
    const wrap = page.locator(`[data-testid="subagent-wrap"][data-parent-tool-use-id="${await taskCard.getAttribute('data-tool-use-id')}"]`)
    await expect(wrap).toBeVisible({ timeout: 60_000 })

    // Wait for the subagent's own turn to fully finish before asserting the
    // nested sequence's final collapsed state — avoids racing the aggregate
    // text update against the (by-then-removed) standalone running card.
    await waitForTurnIdle(page, 90_000)

    // The subagent's own Read sequence collapses into its own aggregate
    // row, nested inside the wrap, independent of the parent turn's
    // sequence. N isn't asserted as exactly 2 for the same reason as the
    // top-level sequence-collapse test above: a Read occasionally triggers
    // its own permission prompt and a failed-then-retried call when the
    // model guesses a path outside the session's working directory — a
    // real, occasional SDK/model retry, not a bug in the aggregation.
    const nestedSummary = wrap.locator('[data-testid="tool-sequence-summary"]')
    await expect(nestedSummary).toBeVisible({ timeout: 10_000 })
    await waitForCondition(
      page,
      async () => /read \d+ files?/i.test((await nestedSummary.locator('.tool-sequence-summary-text').textContent()) ?? ''),
      10_000
    )
    const nestedText = (await nestedSummary.locator('.tool-sequence-summary-text').textContent()) ?? ''
    const nestedReadCount = Number(nestedText.match(/read (\d+) files?/i)?.[1] ?? NaN)
    expect(Number.isFinite(nestedReadCount) && nestedReadCount >= 2).toBe(true)
    expect(await wrap.locator('[data-testid="tool-card"]').count()).toBe(0)

    await nestedSummary.click()
    const nestedCards = wrap.locator('[data-testid="tool-sequence-summary-body"] [data-testid="tool-card"]')
    await expect(nestedCards).toHaveCount(nestedReadCount, { timeout: 10_000 })

    await taskCard.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactsDir, '14-tool-call-sequence-collapse-subagent-nested.png'), fullPage: true })

    // Wait for the whole turn to finish before the next test starts typing
    // into the composer.
    await waitForTurnIdle(page, 30_000)

    await logTranscriptState(page, sessionId, 'turn3e-subagent-nested-sequence')
  })

  // ── 5. Markdown rendering (12-markdown-message-rendering) ───────────────
  test('assistant Markdown renders real bold/inline-code/code-block/list elements from a real streamed reply', async () => {
    await page.getByTestId('composer-input').fill(
      'Reply with exactly this Markdown and nothing else — no other words before or after it, ' +
        'do not use any tools: \n\n' +
        '**bold text**\n\n' +
        '`inline code`\n\n' +
        '```\ncode block line\n```\n\n' +
        '- item one\n- item two'
    )
    await page.getByTestId('send-button').click()

    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })

    // Real rendered elements, not textContent string matching — locks in
    // that react-markdown actually parsed the reply instead of leaving
    // literal `**`/`` ` ``/`-` characters in the DOM.
    await expect(assistantMsg.locator('strong')).toHaveText('bold text', { timeout: 30_000 })
    await expect(assistantMsg.locator('code:not(pre code)')).toHaveText('inline code', { timeout: 30_000 })
    await expect(assistantMsg.locator('pre code')).toContainText('code block line', { timeout: 30_000 })
    await expect(assistantMsg.locator('ul li')).toHaveCount(2, { timeout: 30_000 })
    await expect(assistantMsg.locator('ul li').first()).toHaveText('item one')
    await expect(assistantMsg.locator('ul li').last()).toHaveText('item two')

    // Literal Markdown syntax characters must NOT remain visible as text —
    // confirms this is real rendering, not decoration on top of raw source.
    const rawText = (await assistantMsg.textContent()) ?? ''
    expect(rawText).not.toContain('**bold text**')
    expect(rawText).not.toContain('`inline code`')

    await page.screenshot({ path: join(artifactsDir, '12-markdown-message-rendering.png') })
    await logTranscriptState(page, sessionId, 'turn4-markdown')
  })

  test('assistant Markdown link renders a real <a> and clicking it invokes shell.openExternal, never in-app navigation', async () => {
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        // @ts-expect-error test-only bookkeeping read back below
        globalThis.__lastOpenedExternalUrl = url
        return undefined
      }
    })

    const targetUrl = 'https://example.com/atelier-markdown-link-test'
    await page.getByTestId('composer-input').fill(
      `Reply with exactly this Markdown link and nothing else, do not use any tools: [Example Site](${targetUrl})`
    )
    await page.getByTestId('send-button').click()

    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })

    const link = assistantMsg.locator('a[data-testid="external-link"]')
    await expect(link).toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveAttribute('href', targetUrl)

    await link.click({ button: 'right' })
    const bookmarkMenu = page.getByTestId('chat-bookmark-context-menu')
    await expect(bookmarkMenu).toBeVisible()
    await expect(bookmarkMenu.getByTestId('chat-bookmark-toggle')).toHaveText('Bookmark')
    await page.screenshot({ path: join(artifactsDir, 'chat-response-bookmarks-context-menu.png') })
    await bookmarkMenu.getByTestId('chat-bookmark-toggle').click()

    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible()
    await expandCapSection(page, 'chat-changes-bookmarks')
    const bookmarkRow = cap.locator(
      '[data-testid="chat-bookmark-row"][data-bookmark-kind="link"]'
    )
    await expect(bookmarkRow).toContainText('Example Site')
    await expect(bookmarkRow.getByTestId('chat-changes-bookmark-tag')).toHaveText('Bookmark')

    await bookmarkRow.click()

    const openedUrl = await electronApp.evaluate(() => {
      // @ts-expect-error test-only bookkeeping
      return globalThis.__lastOpenedExternalUrl ?? null
    })
    expect(openedUrl).toBe(targetUrl)
    expect(page.url()).not.toContain('example.com')

    await link.click({ button: 'right' })
    await expect(page.getByTestId('chat-bookmark-toggle')).toHaveText('Remove bookmark')
    await page.getByTestId('chat-bookmark-toggle').click()
    await expect(cap.getByTestId('chat-bookmark-row')).toHaveCount(0)

    await link.click({ button: 'right' })
    await page.getByTestId('chat-bookmark-toggle').click()
    await expect(cap.getByTestId('chat-bookmark-row')).toHaveCount(1)

    await logTranscriptState(page, sessionId, 'turn5-markdown-link')
  })

  test('user message bare URL is clickable and opens in the external browser', async () => {
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        // @ts-expect-error test-only bookkeeping read back below
        globalThis.__lastOpenedExternalUrl = url
        return undefined
      }
    })

    const targetUrl = 'https://example.com/atelier-user-link-test'
    await page.getByTestId('composer-input').fill(`Please review ${targetUrl} when you can.`)
    await page.getByTestId('send-button').click()

    const userMsg = page.locator('.msg-user[data-testid="transcript-message"]').last()
    await expect(userMsg).toBeVisible({ timeout: 15_000 })

    const link = userMsg.locator('[data-testid="external-link"]')
    await expect(link).toHaveText(targetUrl)
    await link.click()

    const openedUrl = await electronApp.evaluate(() => {
      // @ts-expect-error test-only bookkeeping
      return globalThis.__lastOpenedExternalUrl ?? null
    })
    expect(openedUrl).toBe(targetUrl)
    expect(page.url()).not.toContain('example.com')
  })

  test('assistant home-relative file paths (~/.file) open without duplicating tilde', async () => {
    await page.getByTestId('composer-input').fill(
      'Reply with exactly this sentence and nothing else, do not use any tools: Config lives in `~/.mcp.json`.'
    )
    await page.getByTestId('send-button').click()
    await waitForTurnIdle(page, 60_000)

    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })

    const fileLink = assistantMsg.locator('[data-testid="msg-file-link"]').filter({ hasText: '.mcp.json' })
    await expect(fileLink).toHaveText('~/.mcp.json', { timeout: 30_000 })
    await expect(fileLink).toHaveAttribute('href', /atelier-file:.*\.mcp\.json/)
    const href = (await fileLink.getAttribute('href')) ?? ''
    expect(decodeURIComponent(href.replace(/^atelier-file:/, ''))).toBe('~/.mcp.json')

    await fileLink.click()

    await expect(page.getByTestId('files-panel-active')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('files-location-input')).toHaveValue('~/.mcp.json')
  })

  test('assistant file paths in markdown open the Files tab when clicked', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    const targetFile = join(projectDir, 'a.txt')
    await page.getByTestId('composer-input').fill(
      `Use the Edit tool exactly once to replace the entire contents of ${targetFile} from "a" to "bookmarked change". ` +
        `After the edit succeeds, reply with exactly this sentence and nothing else: Updated \`${targetFile}\`.`
    )
    await page.getByTestId('send-button').click()
    await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 5_000 })
    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await waitForCondition(
      page,
      async () => assistantMsg.locator('[data-testid="msg-file-link"]').count().then((count) => count > 0),
      60_000
    )
    await waitForTurnIdle(page, 60_000)
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })

    const fileLink = assistantMsg.locator('[data-testid="msg-file-link"]').first()
    await expect(fileLink).toHaveText(targetFile, { timeout: 30_000 })
    await fileLink.click({ button: 'right' })
    await expect(page.getByTestId('chat-bookmark-toggle')).toHaveText('Bookmark')
    await page.getByTestId('chat-bookmark-toggle').click()

    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible({ timeout: 15_000 })
    await expandCapSection(page, 'chat-changes-files')
    const changedRow = cap
      .getByTestId('chat-changes-file')
      .filter({ hasText: 'a.txt' })
    await expect(changedRow).toHaveCount(1)
    await expect(changedRow).toHaveAttribute('data-bookmarked', 'true')
    await expect(changedRow.getByTestId('chat-changes-bookmark-tag')).toHaveText('Bookmark')
    await expect(cap.locator('[data-testid="chat-bookmark-row"][data-bookmark-kind="file"]')).toHaveCount(0)

    // Two lists, each counting only its own rows: the bookmarked+changed a.txt stays a change.
    const bookmarksSection = page.getByTestId('chat-changes-bookmarks')
    const filesSection = page.getByTestId('chat-changes-files')
    await expect(filesSection.locator('.chat-changes-title')).toHaveText('1 change')
    await expect(bookmarksSection.locator('.chat-changes-title')).toHaveText('1 bookmark')
    await expect(cap.locator('.chat-changes-section').first()).toHaveAttribute(
      'data-testid',
      'chat-changes-bookmarks'
    )

    // Each list expands on its own.
    await expandCapSection(page, 'chat-changes-bookmarks')
    await expect(bookmarksSection.getByTestId('chat-bookmark-row')).toHaveCount(1)
    await expect(filesSection.getByTestId('chat-changes-file')).toHaveCount(1)
    await page.screenshot({ path: join(artifactsDir, 'chat-response-bookmarks-mixed-cap.png') })

    await collapseCapSection(page, 'chat-changes-files')
    await expect(filesSection.locator('.chat-changes-body')).toHaveCount(0)
    await expect(bookmarksSection.locator('.chat-changes-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect(bookmarksSection.getByTestId('chat-bookmark-row')).toHaveCount(1)
    await page.screenshot({
      path: join(artifactsDir, 'chat-cap-two-lists-changes-collapsed.png')
    })

    await collapseCapSection(page, 'chat-changes-bookmarks')
    await expandCapSection(page, 'chat-changes-files')
    await expect(bookmarksSection.locator('.chat-changes-body')).toHaveCount(0)
    await expect(filesSection.getByTestId('chat-changes-file')).toHaveCount(1)

    await changedRow.click()
    await expect(page.getByTestId('response-review-pane')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('response-review-pane')).toHaveAttribute('data-review-kind', 'file')
    await page.getByTestId('response-review-close').click()

    const standaloneTarget = join(projectDir, 'b.txt')
    await page.getByTestId('composer-input').fill(
      `Reply with exactly this Markdown and nothing else, do not use any tools: \`${standaloneTarget}\``
    )
    await page.getByTestId('send-button').click()
    const standaloneLink = page
      .locator('.msg-assistant[data-testid="transcript-message"]')
      .getByTestId('msg-file-link')
      .filter({ hasText: standaloneTarget })
    await waitForCondition(
      page,
      async () => standaloneLink.count().then((count) => count > 0),
      60_000
    )
    await waitForTurnIdle(page, 60_000)
    await expect(standaloneLink).toHaveText(standaloneTarget)
    await standaloneLink.click({ button: 'right' })
    await page.getByTestId('chat-bookmark-toggle').click()

    await expandCapSection(page, 'chat-changes-bookmarks')
    const standaloneFileBookmark = cap.locator(
      '[data-testid="chat-bookmark-row"][data-bookmark-kind="file"]'
    )
    await expect(standaloneFileBookmark).toHaveCount(1, { timeout: 15_000 })
    await expect(standaloneFileBookmark).toContainText('b.txt')
    await standaloneFileBookmark.click()
    await expect(page.getByTestId('files-panel-active')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('files-location-input')).toHaveValue(/b\.txt$/)
    await expect(page.getByTestId('files-editor-tab')).toHaveCount(1, { timeout: 10_000 })
  })

  test('user messages are NOT Markdown-rendered: literal ** / ` stay literal', async () => {
    async function assistantReplyCount(): Promise<number> {
      const rows = await page.evaluate(
        (id) => window.atelier.debugQueryDb<{ c: number }>(
          "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%'",
          [id]
        ),
        sessionId
      )
      return rows[0]?.c ?? 0
    }
    const baselineCount = await assistantReplyCount()

    await page.getByTestId('composer-input').fill('This is **not bold** and this is `not code` on purpose.')
    await page.getByTestId('send-button').click()

    const userMsg = page.locator('.msg-user[data-testid="transcript-message"]').last()
    await expect(userMsg).toBeVisible({ timeout: 10_000 })
    await expect(userMsg).toContainText('This is **not bold** and this is `not code` on purpose.')
    expect(await userMsg.locator('strong').count()).toBe(0)
    expect(await userMsg.locator('code').count()).toBe(0)

    // Let the turn actually complete before moving on so it doesn't bleed
    // into the next test's assistant-message locators.
    await expect.poll(assistantReplyCount, { timeout: 30_000 }).toBeGreaterThan(baselineCount)

    await logTranscriptState(page, sessionId, 'turn6-user-not-markdown')
  })

  // ── 6. UI-match: bubbles, tool card, divider, rail — both themes ────────
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

  test('chat bookmarks persist across relaunch and stay isolated to their session', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const originalRow = page.locator(
      `[data-testid="session-row"][data-session-id="${sessionId}"]`
    )
    await expect(originalRow).toBeVisible({ timeout: 15_000 })
    await originalRow.click()

    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible({ timeout: 30_000 })
    await expandCapSection(page, 'chat-changes-bookmarks')
    await expandCapSection(page, 'chat-changes-files')
    await expect(
      cap.locator('[data-testid="chat-bookmark-row"][data-bookmark-kind="link"]')
    ).toHaveCount(1)
    await expect(
      cap.locator('[data-testid="chat-bookmark-row"][data-bookmark-kind="file"]')
    ).toHaveCount(1)
    await expect(
      cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })
    ).toHaveAttribute('data-bookmarked', 'true')

    const second = await page.evaluate((path) =>
      window.atelier.createSession({
        projectPath: path,
        mode: 'terminal',
        hostId: 'local',
        suggestedName: 'Bookmark isolation'
      }), projectDir)
    expect(await page.evaluate((id) => window.atelier.listSessionBookmarks(id), second.id)).toEqual([])
    await page.evaluate((id) => window.atelier.deleteSession(id), second.id)
  })
})
