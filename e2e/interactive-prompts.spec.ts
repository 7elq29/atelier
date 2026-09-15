import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { commentOnReviewSelection, commentOnTranscriptSelection, e2eConfigPath as configPath, openReviewCommentPopover, seedE2eConfig, seedSkipOnboarding, selectReviewPaneText, selectTranscriptCommentText } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const logPath = join(artifactsDir, '05-prompts.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(logPath, '')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


async function execDb(page: Page, sql: string, params: unknown[] = []): Promise<void> {
  await page.evaluate(({ sql: query, params: bindings }) => window.atelier.debugExecDb(query, bindings), {
    sql,
    params
  })
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

async function activateLatestSession(page: Page): Promise<string> {
  const sessionRow = page.locator('[data-testid="session-row"]').last()
  await expect(sessionRow).toBeVisible({ timeout: 15_000 })
  await sessionRow.click()
  const sessionId = (await sessionRow.getAttribute('data-session-id')) as string
  expect(sessionId).toBeTruthy()
  return sessionId
}

function activeComposer(page: Page) {
  return page.getByTestId('composer-input').last()
}

function activeSendButton(page: Page) {
  return page.getByTestId('send-button').last()
}

async function fillProjectPath(page: Page, path: string): Promise<void> {
  const input = page.getByTestId('project-path')
  await input.fill(path)
  // Blur closes the path suggestion dropdown so mode buttons stay clickable.
  await page.getByTestId('new-session-modal').locator('h2').click()
}

async function selectClaudeCodeMode(page: Page): Promise<void> {
  await page.getByTestId('mode-claude-code').click()
}

async function activateViaKeyboardHint(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await page.keyboard.down('Meta')
  try {
    await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 5_000 })
    await expect(target).toHaveAttribute('data-keyboard-hint-label', /^[a-z]+$/)
    const label = await target.getAttribute('data-keyboard-hint-label')
    expect(label).toBeTruthy()
    for (const key of label!) await page.keyboard.press(key)
  } finally {
    await page.keyboard.up('Meta')
  }
}

/** Appends every message row for `sessionId` to the proof-artifact log, tagged with `label` — same pattern as chat-surface-core.spec.ts's logTranscriptState. */
async function logTranscriptState(page: Page, sessionId: string, label: string): Promise<void> {
  const rows = await page.evaluate(
    (id) =>
      window.atelier.debugQueryDb<{ role: string; content: string; created_at: string }>(
        'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC',
        [id]
      ),
    sessionId
  )
  const lines = rows.map((r) => `[${label}] ${r.role}: ${r.content.slice(0, 400)}`)
  writeFileSync(logPath, lines.join('\n') + '\n', { flag: 'a' })
}

test.describe.configure({ mode: 'serial' })

test.describe('05-interactive-prompts', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-prompts-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-prompts-project-'))
    writeFileSync(join(projectDir, 'README.md'), '# test project\n')
    // A real (but instant, offline) "npm test" script — avoids npm's slow
    // registry-lookup/ENOENT path when no package.json exists, which made
    // the permission test's Bash calls flaky/slow in earlier runs.
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'atelier-e2e-prompts-project', version: '0.0.0', scripts: { test: 'echo test-ran' } }, null, 2)
    )
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. AskUserQuestion: real clickable card, answer round-trips into the SDK ──
  test('AskUserQuestion: clicking an option sends the structured answer back into the SDK, conversation continues with it', async () => {
        await openNewSessionModal(page)
    await fillProjectPath(page, projectDir)
    await selectClaudeCodeMode(page)
    await page.getByTestId('initial-prompt').fill(
      'Use the AskUserQuestion tool right now to ask me exactly one question: "Which fruit do you prefer?" ' +
        'with header "Fruit" and exactly two options: "Apple" (a crisp, sweet fruit) and "Banana" (a soft, tropical fruit). ' +
        'Do not do anything else first. Wait for my answer, then reply with a single sentence saying exactly which fruit I picked.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const sessionId = await activateLatestSession(page)

    const card = page.getByTestId('ask-user-question-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Which fruit do you prefer?')

    const sessionRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(sessionRow.getByTestId('session-dot')).toHaveClass(/status-waiting-blocked/)
    await expect(page.getByTestId('tool-awaiting-user-indicator').last()).toBeVisible()

    const options = card.getByTestId('aq-option')
    await expect(options).toHaveCount(2) // Apple, Banana (the "Other" row has its own data-testid)
    await expect(card.getByTestId('aq-option-other')).toHaveCount(1)
    const appleOption = options.filter({ hasText: 'Apple' })
    await expect(appleOption).toHaveCount(1)

    await page.screenshot({ path: join(artifactsDir, '05-askuserquestion.png') })

    // The "Other" row opens a bare textarea: it carries no inline submit of its
    // own, so the card's single explicit Submit is what enables once free text
    // is typed.
    await card.getByTestId('aq-option-other').click()
    const otherBox = card.getByTestId('aq-other-box')
    await expect(otherBox).toHaveClass(/show/)
    await expect(otherBox.getByTestId('aq-other-send')).toHaveCount(0)
    await expect(card.getByTestId('aq-submit')).toBeDisabled()
    await otherBox.getByTestId('aq-other-input').fill('Cherry')
    await expect(card.getByTestId('aq-submit')).toBeEnabled()
    await expect(otherBox).toHaveCSS('margin-top', '8px')
    const focusedInputBorder = await otherBox
      .getByTestId('aq-other-input')
      .evaluate((el) => getComputedStyle(el).borderColor)
    const selectedOtherBorder = await card
      .getByTestId('aq-option-other')
      .evaluate((el) => getComputedStyle(el).borderColor)
    expect(focusedInputBorder).toBe(selectedOtherBorder)
    await page.screenshot({ path: join(artifactsDir, '05-askuserquestion-other-freetext.png') })

    // The existing hold-⌘ hint overlay invokes the option with the same
    // select-only semantics as a click; explicit Submit remains required.
    await activateViaKeyboardHint(page, appleOption)
    await expect(otherBox).not.toHaveClass(/show/)

    // bug #52: a single click only selects — the card stays pending until an
    // explicit Submit click.
    await expect(card).toHaveAttribute('data-status', 'pending')
    await expect(appleOption).toHaveClass(/selected/)
    const appleBackground = await appleOption.evaluate((el) => getComputedStyle(el).backgroundColor)
    const bananaBackground = await options.filter({ hasText: 'Banana' }).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(appleBackground).toBe(bananaBackground)
    await expect(appleOption.locator('.num')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const submitButton = card.getByTestId('aq-submit')
    await expect(submitButton).toBeEnabled()
    const accentColor = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--accent)'
      document.body.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await expect(card.locator('.aq-head')).toHaveCSS('color', accentColor)
    await expect(submitButton).not.toHaveCSS('background-color', accentColor)
    await submitButton.click()

    // Card flips to resolved; summary merges into the tool-activity row (AskUserQuestion tool + card).
    const askSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /question answered/i }).last()
    await expect(askSummary).toBeVisible({ timeout: 10_000 })
    await expect(askSummary.locator('.tool-sequence-summary-text')).toContainText('Apple')
    await expect(page.getByTestId('ask-user-question-card-fold')).toHaveCount(0)
    await askSummary.click()
    const resolvedCard = page.getByTestId('ask-user-question-card').first()
    await expect(resolvedCard).toHaveAttribute('data-status', 'answered')
    await expect(resolvedCard.getByTestId('aq-option').filter({ hasText: 'Apple' })).toHaveClass(/selected/)

    // The conversation actually continues using that answer: Claude's next
    // reply must reference "Apple" specifically, proving the SDK received
    // the structured `answers` payload (not a UI-only state change — the
    // documented Bug #92 this fixes).
    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(
            (id) =>
              window.atelier.debugQueryDb<{ content: string }>(
                "SELECT content FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' ORDER BY id DESC LIMIT 1",
                [id]
              ),
            sessionId
          )
          return rows[0]?.content ?? ''
        },
        { timeout: 30_000 }
      )
      .toContain('Apple')

    await logTranscriptState(page, sessionId, 'ask-user-question')
  })

  test('AskUserQuestion: multi-question batch uses stepper nav and explicit Submit on last step', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await openNewSessionModal(page)
    await fillProjectPath(page, projectDir)
    await selectClaudeCodeMode(page)
    await page.getByTestId('initial-prompt').fill(
      'Use the AskUserQuestion tool right now to ask me exactly three questions in one call. ' +
        'Question 1 header "Scope", question text "Which scope?", options "Small" and "Large". ' +
        'Question 2 header "Path", question text "Which path?", options "Worktree" and "Repo". ' +
        'Question 3 header "Revert", question text "Which revert?", options "Auto" and "Manual". ' +
        'Do not do anything else first. Wait for all my answers, then reply with one sentence listing all three picks.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const sessionId = await activateLatestSession(page)
    const card = page.getByTestId('ask-user-question-card')
    await expect(card).toBeVisible({ timeout: 45_000 })
    await expect(card).toContainText('Claude is asking 3 questions')
    await expect(card.getByTestId('aq-stepper')).toBeVisible()
    await expect(card.getByTestId('aq-step')).toHaveCount(3)
    await expect(card.getByTestId('aq-step-count')).toContainText('Question 1 of 3')

    await card.getByTestId('aq-option').filter({ hasText: 'Small' }).click()
    await expect(card.getByTestId('aq-step-count')).toContainText('Question 2 of 3')

    // Free text inside the stepper: the box holds only the textarea, and the
    // stepper's own Next is the single control that confirms and advances.
    await card.getByTestId('aq-option-other').click()
    const otherBox = card.getByTestId('aq-other-box')
    await expect(otherBox).toHaveClass(/show/)
    await expect(otherBox.getByTestId('aq-other-send')).toHaveCount(0)
    await expect(card.getByTestId('aq-next')).toBeDisabled()
    await otherBox.getByTestId('aq-other-input').fill('Custom vault path')
    await page.screenshot({ path: join(artifactsDir, '05-askuserquestion-stepper-other.png') })
    await expect(card.getByTestId('aq-next')).toBeEnabled()
    await card.getByTestId('aq-next').click()
    await expect(card.getByTestId('aq-step-count')).toContainText('Question 3 of 3')

    await expect(card.getByTestId('aq-next')).toHaveCount(0)
    await card.getByTestId('aq-option').filter({ hasText: 'Auto' }).click()
    const submitButton = card.getByTestId('aq-submit')
    await expect(submitButton).toBeEnabled()
    await submitButton.click()

    const askSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /question answered/i }).last()
    await expect(askSummary).toBeVisible({ timeout: 15_000 })
    // The free-text pick reached the SDK payload, submitted by Next + Submit alone.
    await expect(askSummary.locator('.tool-sequence-summary-text')).toContainText('Custom vault path')
    await askSummary.click()
    await expect(page.getByTestId('ask-user-question-card').first()).toHaveAttribute('data-status', 'answered')

    await page.screenshot({ path: join(artifactsDir, '05-askuserquestion-multi-stepper.png') })
    await logTranscriptState(page, sessionId, 'ask-user-question-multi')
  })

  // ── 2. Permission prompts: real Allow/Deny before the tool runs, plus "always allow" ──
  test('Permission: Allow runs the tool, Deny blocks it, and "always allow" suppresses a second identical prompt', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
        await openNewSessionModal(page)
    await fillProjectPath(page, projectDir)
    await selectClaudeCodeMode(page)
    await page.getByTestId('initial-prompt').fill(
      'Use the Bash tool to run exactly: npm test -- --atelier-e2e-marker-one. ' +
        'Report the exit code and first line of output in one sentence.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const sessionId = await activateLatestSession(page)

    // First call: deny it, and confirm the tool never actually EXECUTED —
    // its tool-call card (created for every tool_use the SDK announces,
    // approved or not) must settle on 'error' with a denial message, never
    // 'completed' — proving canUseTool gated it BEFORE execution rather than
    // the UI just reacting to an after-the-fact failed run.
    const permCard1 = page.getByTestId('permission-card').first()
    await expect(permCard1).toBeVisible({ timeout: 30_000 })
    await expect(permCard1.getByTestId('perm-cmd')).toContainText('npm test')
    await page.screenshot({ path: join(artifactsDir, '05-permission.png') })

    await activateViaKeyboardHint(page, permCard1.getByTestId('perm-deny'))
    const denySummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /permission denied/i }).last()
    await expect(denySummary).toBeVisible({ timeout: 10_000 })
    await expect(denySummary.locator('.tool-sequence-summary-text')).toContainText('npm test')
    await expect(permCard1.getByTestId('permission-card-fold')).toHaveCount(0)
    await denySummary.click()
    await expect(permCard1.getByTestId('perm-resolved')).toContainText('Denied')

    const toolCard1 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-one' })
    await expect(toolCard1).toBeVisible({ timeout: 10_000 })
    await expect(toolCard1).toHaveAttribute('data-tool-status', 'error', { timeout: 10_000 })
    await toolCard1.click()
    await expect(toolCard1.getByTestId('tool-output')).toContainText('User denied this action')
    await denySummary.click()

    // Second turn: run the SAME pattern twice, back to back, in one turn.
    // Allow + "always allow" on the first; the second must complete WITHOUT
    // a new permission card — the SDK's own session-scoped permission engine
    // (not a client-side re-implementation) auto-approves the match. Kept
    // within a single turn deliberately: each follow-up composer message
    // reconnects via the SDK's `resume` mechanism (see manager.ts's
    // sendUserMessage doc comment), and this task only claims the allowlist
    // is scoped to "the session" for the DURATION of one live SDK
    // connection, not guaranteed to survive a resume reconnect.
    await activeComposer(page).fill(
      'Use the Bash tool to run exactly: npm test -- --atelier-e2e-marker-two. ' +
        'Immediately after that command finishes (whether it succeeds or fails), in the SAME turn use the Bash tool again ' +
        'to run exactly: npm test -- --atelier-e2e-marker-three. Then report what happened to both in one sentence.'
    )
    await activeSendButton(page).click()

    const permCard2 = page.getByTestId('permission-card').nth(1)
    await expect(permCard2).toBeVisible({ timeout: 30_000 })
    await expect(permCard2.getByTestId('perm-always-allow')).toBeVisible()
    await permCard2.getByTestId('perm-always-allow').check()
    await activateViaKeyboardHint(page, permCard2.getByTestId('perm-allow'))
    const allowSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /permission allowed/i }).last()
    await expect(allowSummary).toBeVisible({ timeout: 10_000 })
    await expect(allowSummary.locator('.tool-sequence-summary-text')).toContainText('npm test')
    // Resolved permission cards must fold into the summary — not stay expanded as full cards.
    await expect(page.locator('[data-testid="permission-card"] .perm-actions')).toHaveCount(0)
    await expect(allowSummary).not.toHaveClass(/(?:^|\s)open(?:\s|$)/)

    const toolCard2 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-two' })
    await expect(toolCard2).toBeVisible({ timeout: 30_000 })
    await expect(toolCard2).toHaveAttribute('data-tool-status', 'completed', { timeout: 60_000 })

    // Third identical-pattern call, same turn: must run WITHOUT a new
    // permission card ever appearing.
    const permCardCountBeforeThird = await page.getByTestId('permission-card').count()

    const toolCard3 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-three' })
    await expect(toolCard3).toBeVisible({ timeout: 30_000 })
    await expect(toolCard3).toHaveAttribute('data-tool-status', 'completed', { timeout: 60_000 })

    const permCardCountAfterThird = await page.getByTestId('permission-card').count()
    expect(permCardCountAfterThird).toBe(permCardCountBeforeThird) // no new permission card was created

    await logTranscriptState(page, sessionId, 'permission')
  })

  // ── 3. Plan mode: real Accept/Reject that resolve the SDK-side approval ──
  test('Plan mode: Reject keeps Claude planning, Accept exits plan mode and lets the file write actually happen', async () => {
        await openNewSessionModal(page)
    await fillProjectPath(page, projectDir)
    await selectClaudeCodeMode(page)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const sessionId = await activateLatestSession(page)

    const composer = activeComposer(page)
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.click()
    await composer.press('Shift+Tab')
    await expect(page.getByTestId('composer-mode-pill')).toHaveAttribute('data-mode', 'plan', { timeout: 10_000 })
    await composer.fill(
      'Make a short 2-step plan to create a file called atelier-plan-test.txt containing exactly the text hello-plan, ' +
        'then call ExitPlanMode to present the plan for approval. Do not create the file or call any other tool first.'
    )
    await activeSendButton(page).click()

    const planCard1 = page.getByTestId('plan-card').first()
    await expect(planCard1).toBeVisible({ timeout: 45_000 })
    await expect(planCard1.getByTestId('plan-body')).toContainText('atelier-plan-test.txt')
    await page.screenshot({ path: join(artifactsDir, '05-plan.png') })

    const planHost = planCard1.getByTestId('transcript-comment-host')
    await expect(planHost).toBeVisible()
    await selectTranscriptCommentText(planHost, 'atelier-plan-test.txt')
    await commentOnTranscriptSelection(planHost, 'Inline plan comment in transcript')
    await expect(page.getByTestId('review-composer-comment-list')).toBeVisible()
    const inlineCommentRow = page.getByTestId('review-composer-comment-card').last()
    await expect(inlineCommentRow.getByTestId('review-composer-comment-quote')).toContainText('atelier-plan-test.txt')
    await expect(inlineCommentRow.getByTestId('review-composer-comment-line')).toHaveText(/line \d+/)
    await expect(inlineCommentRow.getByTestId('review-composer-comment-body')).toHaveValue('Inline plan comment in transcript')
    await expect(activeComposer(page)).toHaveValue('')
    await expect(activeComposer(page)).not.toContainText(/Re plan/)
    await expect(page.getByTestId('response-review-pane')).toHaveCount(0)

    await planCard1.getByTestId('plan-review-button').click()
    const reviewPane = page.getByTestId('response-review-pane')
    await expect(reviewPane).toBeVisible()
    await expect(reviewPane).toHaveAttribute('data-review-kind', 'plan')
    await expect(page.getByTestId('response-review-title')).toHaveText('Plan review')
    await expect(planCard1).toHaveClass(/response-review-selected/)
    await expect(reviewPane.getByTestId('response-review-content')).toBeVisible()
    await selectReviewPaneText(reviewPane, 'atelier-plan-test.txt')
    await commentOnReviewSelection(reviewPane, 'Please add rollback steps')
    await openReviewCommentPopover(reviewPane)
    await expect(reviewPane.getByTestId('response-review-saved-body')).toHaveText(
      'Please add rollback steps'
    )
    await expect(page.getByTestId('review-composer-comment-list')).toBeVisible()
    const reviewCommentRow = page.getByTestId('review-composer-comment-card').last()
    await expect(reviewCommentRow.getByTestId('review-composer-comment-quote')).toContainText('atelier-plan-test.txt')
    await expect(reviewCommentRow.getByTestId('review-composer-comment-line')).toHaveText(/line \d+/)
    await expect(reviewCommentRow.getByTestId('review-composer-comment-body')).toHaveValue('Please add rollback steps')
    await expect(activeComposer(page)).toHaveValue('')
    await expect(activeComposer(page)).not.toContainText(/Re plan/)
    await page.getByTestId('response-review-close').click()
    await expect(reviewPane).toHaveCount(0)

    // Reject: summary merges into the tool-activity row; expand to read the note.
    await activateViaKeyboardHint(page, planCard1.getByTestId('plan-reject'))
    const rejectSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /proposed plan — rejected/i }).last()
    await expect(rejectSummary).toBeVisible({ timeout: 10_000 })
    await expect(planCard1.getByTestId('plan-card-fold')).toHaveCount(0)
    await rejectSummary.click()
    await expect(planCard1.getByTestId('plan-resolved-note')).toContainText('rejected')

    // Wait for Claude's turn (reacting to the rejection) to actually finish
    // before sending the next composer message, so it doesn't race an
    // in-flight turn.
    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (id) =>
            window.atelier.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%'",
              [id]
            ),
          sessionId
        )
        return rows[0]?.c ?? 0
      }, { timeout: 30_000 })
      .toBeGreaterThan(0)

    // Ask again, expect a second plan card, this time accept it.
    await activeComposer(page).fill(
      'Please propose the exact same plan again (create atelier-plan-test.txt containing hello-plan) via ExitPlanMode.'
    )
    await activeSendButton(page).click()

    const planCard2 = page.getByTestId('plan-card').nth(1)
    await expect(planCard2).toBeVisible({ timeout: 45_000 })
    await planCard2.getByTestId('plan-review-button').click()
    const reviewPane2 = page.getByTestId('response-review-pane')
    await expect(reviewPane2).toHaveAttribute('data-has-plan-diff', 'true')
    await expect(reviewPane2.getByTestId('response-review-content')).toBeVisible()
    await page.getByTestId('response-review-close').click()
    await activateViaKeyboardHint(page, planCard2.getByTestId('plan-accept'))
    const acceptSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /proposed plan — accepted/i }).last()
    await expect(acceptSummary).toBeVisible({ timeout: 10_000 })
    await expect(planCard2.getByTestId('plan-card-fold')).toHaveCount(0)
    await acceptSummary.click()
    await expect(planCard2.getByTestId('plan-resolved-note')).toContainText('accepted')

    // Real SDK-side approval: a Write tool call for the file must actually
    // run and complete after acceptance (proves setPermissionMode('default')
    // really exited plan mode, not just that the card's own UI flipped).
    const writeCard = page.locator('[data-testid="tool-card"][data-tool-name="Write"]').first()
    await expect(writeCard).toBeVisible({ timeout: 30_000 })
    await expect(writeCard).toHaveAttribute('data-tool-status', 'completed', { timeout: 30_000 })

    await logTranscriptState(page, sessionId, 'plan')
  })

  // ── 4. UI-match: token-driven callout styling, both themes ──
  test('UI-match: interactive-prompt cards resolve --bg-panel (not a hardcoded background), both themes', async () => {
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

    // The permission/plan cards from tests 2–3 are folded into tool-sequence summaries.
    const permSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /permission denied/i }).first()
    await permSummary.click()
    const permCard = page.getByTestId('permission-card').first()
    const planSummary = page.locator('[data-testid="tool-sequence-summary"]').filter({ hasText: /proposed plan — rejected/i }).first()
    await planSummary.click()
    const planCard = page.getByTestId('plan-card').first()

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    const permBgLight = await permCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    const planBgLight = await planCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(permBgLight).toBe(await resolveToken('--bg-panel'))
    expect(planBgLight).toBe(await resolveToken('--bg-panel'))
    await page.screenshot({ path: join(artifactsDir, '05-ui-match-light.png'), fullPage: true })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    const permBgDark = await permCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    const planBgDark = await planCard.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(permBgDark).toBe(await resolveToken('--bg-panel'))
    expect(planBgDark).toBe(await resolveToken('--bg-panel'))
    // Light and dark --bg-panel are genuinely different tokens — confirms
    // this tracks the token per theme rather than a hardcoded color (the
    // rejected earlier hardcoded-dark-background pattern spec.md calls out).
    expect(permBgDark).not.toBe(permBgLight)
    await page.screenshot({ path: join(artifactsDir, '05-ui-match-dark.png'), fullPage: true })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  })
})
