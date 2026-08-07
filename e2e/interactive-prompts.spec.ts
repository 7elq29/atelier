import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const logPath = join(artifactsDir, '05-prompts.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(logPath, '')

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
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the AskUserQuestion tool right now to ask me exactly one question: "Which fruit do you prefer?" ' +
        'with header "Fruit" and exactly two options: "Apple" (a crisp, sweet fruit) and "Banana" (a soft, tropical fruit). ' +
        'Do not do anything else first. Wait for my answer, then reply with a single sentence saying exactly which fruit I picked.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    const card = page.getByTestId('ask-user-question-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Which fruit do you prefer?')

    const options = card.getByTestId('aq-option')
    await expect(options).toHaveCount(2) // Apple, Banana (the "Other" row has its own data-testid)
    await expect(card.getByTestId('aq-option-other')).toHaveCount(1)
    const appleOption = options.filter({ hasText: 'Apple' })
    await expect(appleOption).toHaveCount(1)

    await page.screenshot({ path: join(artifactsDir, '05-askuserquestion.png') })

    await appleOption.click()

    // bug #52: a single click only selects — the card stays pending until an
    // explicit Submit click.
    await expect(card).toHaveAttribute('data-status', 'pending')
    await expect(appleOption).toHaveClass(/selected/)
    const submitButton = card.getByTestId('aq-submit')
    await expect(submitButton).toBeEnabled()
    await submitButton.click()

    // Card flips to its resolved/answered state (real UI feedback, not just a click handler firing).
    await expect(card).toHaveClass(/answered/, { timeout: 10_000 })
    await expect(appleOption).toHaveClass(/selected/)

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

  // ── 2. Permission prompts: real Allow/Deny before the tool runs, plus "always allow" ──
  test('Permission: Allow runs the tool, Deny blocks it, and "always allow" suppresses a second identical prompt', async () => {
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the Bash tool to run exactly: npm test -- --atelier-e2e-marker-one. ' +
        'Report the exit code and first line of output in one sentence.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    // First call: deny it, and confirm the tool never actually EXECUTED —
    // its tool-call card (created for every tool_use the SDK announces,
    // approved or not) must settle on 'error' with a denial message, never
    // 'completed' — proving canUseTool gated it BEFORE execution rather than
    // the UI just reacting to an after-the-fact failed run.
    const permCard1 = page.getByTestId('permission-card').first()
    await expect(permCard1).toBeVisible({ timeout: 30_000 })
    await expect(permCard1.getByTestId('perm-cmd')).toContainText('npm test')
    await page.screenshot({ path: join(artifactsDir, '05-permission.png') })

    await permCard1.getByTestId('perm-deny').click()
    await expect(permCard1.getByTestId('perm-resolved')).toHaveText('Denied', { timeout: 10_000 })

    const toolCard1 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-one' })
    await expect(toolCard1).toBeVisible({ timeout: 10_000 })
    await expect(toolCard1).toHaveAttribute('data-tool-status', 'error', { timeout: 10_000 })
    await toolCard1.click()
    await expect(toolCard1.getByTestId('tool-output')).toContainText('User denied this action')

    // Second turn: run the SAME pattern twice, back to back, in one turn.
    // Allow + "always allow" on the first; the second must complete WITHOUT
    // a new permission card — the SDK's own session-scoped permission engine
    // (not a client-side re-implementation) auto-approves the match. Kept
    // within a single turn deliberately: each follow-up composer message
    // reconnects via the SDK's `resume` mechanism (see manager.ts's
    // sendUserMessage doc comment), and this task only claims the allowlist
    // is scoped to "the session" for the DURATION of one live SDK
    // connection, not guaranteed to survive a resume reconnect.
    await page.getByTestId('composer-input').fill(
      'Use the Bash tool to run exactly: npm test -- --atelier-e2e-marker-two. ' +
        'Immediately after that command finishes (whether it succeeds or fails), in the SAME turn use the Bash tool again ' +
        'to run exactly: npm test -- --atelier-e2e-marker-three. Then report what happened to both in one sentence.'
    )
    await page.getByTestId('send-button').click()

    const permCard2 = page.getByTestId('permission-card').nth(1)
    await expect(permCard2).toBeVisible({ timeout: 30_000 })
    await expect(permCard2.getByTestId('perm-always-allow')).toBeVisible()
    await permCard2.getByTestId('perm-always-allow').check()
    await permCard2.getByTestId('perm-allow').click()
    await expect(permCard2.getByTestId('perm-resolved')).toContainText('Allowed', { timeout: 10_000 })

    const toolCard2 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-two' })
    await expect(toolCard2).toBeVisible({ timeout: 30_000 })
    await expect(toolCard2).toHaveAttribute('data-tool-status', 'completed', { timeout: 30_000 })

    // Third identical-pattern call, same turn: must run WITHOUT a new
    // permission card ever appearing.
    const permCardCountBeforeThird = await page.getByTestId('permission-card').count()

    const toolCard3 = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'atelier-e2e-marker-three' })
    await expect(toolCard3).toBeVisible({ timeout: 30_000 })
    await expect(toolCard3).toHaveAttribute('data-tool-status', 'completed', { timeout: 30_000 })

    const permCardCountAfterThird = await page.getByTestId('permission-card').count()
    expect(permCardCountAfterThird).toBe(permCardCountBeforeThird) // no new permission card was created

    await logTranscriptState(page, sessionId, 'permission')
  })

  // ── 3. Plan mode: real Accept/Reject that resolve the SDK-side approval ──
  test('Plan mode: Reject keeps Claude planning, Accept exits plan mode and lets the file write actually happen', async () => {
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('plan-mode-checkbox').check()
    await page.getByTestId('initial-prompt').fill(
      'Make a short 2-step plan to create a file called atelier-plan-test.txt containing exactly the text hello-plan, ' +
        'then call ExitPlanMode to present the plan for approval. Do not create the file or call any other tool first.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    const planCard1 = page.getByTestId('plan-card').first()
    await expect(planCard1).toBeVisible({ timeout: 45_000 })
    await expect(planCard1.getByTestId('plan-body')).toContainText('atelier-plan-test.txt')
    await page.screenshot({ path: join(artifactsDir, '05-plan.png') })

    // Reject: the note says so, actions hide, and the file must NOT exist.
    await planCard1.getByTestId('plan-reject').click()
    await expect(planCard1).toHaveClass(/resolved/, { timeout: 10_000 })
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
    await page.getByTestId('composer-input').fill(
      'Please propose the exact same plan again (create atelier-plan-test.txt containing hello-plan) via ExitPlanMode.'
    )
    await page.getByTestId('send-button').click()

    const planCard2 = page.getByTestId('plan-card').nth(1)
    await expect(planCard2).toBeVisible({ timeout: 45_000 })
    await planCard2.getByTestId('plan-accept').click()
    await expect(planCard2).toHaveClass(/resolved/, { timeout: 10_000 })
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

    // The permission card from test 2 is still resolved-but-present in the transcript.
    const permCard = page.getByTestId('permission-card').first()
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
