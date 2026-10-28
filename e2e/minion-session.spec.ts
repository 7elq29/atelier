/**
 * Minion session e2e — real `aifx mcp call minion-orchestrator` (no mocks).
 *
 * Cases (see Features/minion-working-chrome-stall/spec.md):
 *   A — create → SETUP → rich intermediate → answer → follow-up → intermediate → answer
 *   B — create until tools → close (keep remote) → attach → history → follow-up → answer
 *   C — parked (no reliable in-suite “close DevPod”)
 *   D — create until tools → re-attach same UUID → one row + history
 *
 * No pinned “scratch still up” fixtures — those go cold and make false failures.
 */
import { test, expect, type Page, _electron as electron } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

function guiLikeElectronEnv(): Record<string, string> {
  // Keep a GUI-like base PATH, but prepend Homebrew / Uber bins so `usso` and
  // friends resolve the same way as a Dock-launched app after shell-path augment.
  const env: Record<string, string> = {
    PATH: [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/uber/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ].join(':'),
    HOME: process.env.HOME ?? '',
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '/bin/zsh'
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'SSH_AUTH_SOCK', 'ELECTRON_RUN_AS_NODE'] as const) {
    const v = process.env[key]
    if (v) env[key] = v
  }
  return env
}

async function launchMinionApp(userDataDir: string) {
  return electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: guiLikeElectronEnv()
  })
}

async function cleanupMinionSessions(page: Page, opts?: { cancelRemote?: boolean }): Promise<void> {
  await page
    .evaluate(async (cancelRemote) => {
      const sessions = await window.atelier.listActiveSessions()
      for (const s of sessions.filter((x) => x.mode === 'minion')) {
        if (cancelRemote) await window.atelier.interruptSession(s.id).catch(() => undefined)
        await window.atelier.closeSession(s.id).catch(() => undefined)
      }
    }, opts?.cancelRemote ?? true)
    .catch(() => undefined)
}

function setupCard(page: Page) {
  return page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-setup"]')
}

/** Minion working status is plain text above the composer (not a transcript card). */
function workingStatus(page: Page) {
  return page.getByTestId('composer-turn-status')
}

function waitOnlyChrome(page: Page) {
  return workingStatus(page).filter({
    hasText: /waiting for tools|Waiting for session|Connecting to session|Waiting for scratch|Streaming session progress/i
  })
}

/** Markers the agent is asked to emit (plus harness "Done."). */
const ANSWER_RE = /\bDone\.|A1-READY|A2-READY|B-SEED|B-READY|D-READY/i

/** Markdown may strip `` ` `` from user prompts in the DOM — normalize before match. */
function normalizeTranscriptText(s: string): string {
  return s.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function answerMarker(page: Page) {
  return page
    .locator('[data-testid="transcript-message"][data-role="assistant"]')
    .getByText(ANSWER_RE)
}

/**
 * Intermediate = scratch tool activity. Finished tools collapse into
 * `tool-sequence-summary` (no open `tool-card`) — both count.
 */
async function hasToolIntermediate(page: Page): Promise<boolean> {
  if (await page.getByTestId('tool-card').first().isVisible().catch(() => false)) return true
  return page.getByTestId('tool-sequence-summary').first().isVisible().catch(() => false)
}

async function toolIntermediateCount(page: Page): Promise<number> {
  const cards = await page.getByTestId('tool-card').count()
  const summaries = await page.getByTestId('tool-sequence-summary').count()
  return cards + summaries
}

async function expectToolIntermediateVisible(page: Page, timeoutMs: number): Promise<void> {
  await expect
    .poll(() => hasToolIntermediate(page), {
      timeout: timeoutMs,
      intervals: [1_000, 2_000, 5_000]
    })
    .toBeTruthy()
}

/** Intermediate = real tool UI from scratch (not Working chrome alone). */
async function expectIntermediateBeforeDone(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const workingCard = page.locator(
    '[data-testid="conversation-status-card"][data-status-kind="minion-working"]'
  )
  while (Date.now() < deadline) {
    // WORKING must never return as a transcript card.
    if ((await workingCard.count()) > 0) {
      throw new Error('Transcript still shows minion-working card — should be composer-turn-status only')
    }
    if (await hasToolIntermediate(page)) return
    if (await answerMarker(page).first().isVisible().catch(() => false)) {
      const waiting = await waitOnlyChrome(page).count()
      throw new Error(
        waiting > 0
          ? 'Got Done/READY while still on wait-placeholder — scratch never streamed tools'
          : 'Got Done/READY without any tool-card or tool-sequence-summary'
      )
    }
    await page.waitForTimeout(1_500)
  }
  throw new Error(`Timeout ${timeoutMs}ms waiting for tool intermediate UI`)
}

async function expectAssistantAnswerAfter(
  page: Page,
  afterUserText: string,
  timeoutMs: number
): Promise<void> {
  const needle = normalizeTranscriptText(afterUserText)
  await expect
    .poll(
      async () => {
        // Only count assistant rows after the matching user turn — the user
        // prompt itself contains "A1-READY" / "B-SEED" instructions.
        const msgs = page.getByTestId('transcript-message')
        const count = await msgs.count()
        let seenUser = false
        for (let i = 0; i < count; i++) {
          const el = msgs.nth(i)
          const role = await el.getAttribute('data-role')
          const text = normalizeTranscriptText(await el.innerText())
          if (!seenUser) {
            if (role === 'user' && text.includes(needle)) seenUser = true
            continue
          }
          if (role === 'assistant' && ANSWER_RE.test(text)) return true
        }
        return false
      },
      { timeout: timeoutMs, intervals: [2_000, 5_000, 10_000] }
    )
    .toBeTruthy()
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('composer-input')
  await composer.click()
  await composer.fill(text)
  await page.getByTestId('send-button').click()
  // Markdown strips `` ` `` in the transcript — assert without them.
  const visible = text.replace(/`/g, '')
  await expect(page.getByText(visible, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
}

async function createMinionWithPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('mode-minion').click()
  await page.getByTestId('initial-prompt').fill(prompt)
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('minion-tag').first()).toBeVisible({ timeout: 30_000 })
}

async function activeMinionTaskId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const sessions = await window.atelier.listActiveSessions()
    const minion = sessions.find((s) => s.mode === 'minion')
    if (!minion) throw new Error('no minion session')
    return minion.id
  })
}

/** Close Atelier session without cancelling the remote Minion task (pod stays up). */
async function closeMinionKeepRemote(page: Page, taskId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.atelier.closeSession(id, { cancelRemote: false })
  }, taskId)
  // Closed rows stay in the sidebar (`.closed`); attach reopens the same UUID.
  await expect(
    page.locator(`[data-testid="session-row"][data-mode="minion"][data-session-id="${taskId}"]`)
  ).toHaveClass(/closed/, { timeout: 15_000 })
}

async function attachMinionTask(page: Page, taskId: string): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await page.getByTestId('mode-minion').click()
  await page.getByTestId('minion-attach-link').fill(`https://minion.uberinternal.com/v2?taskId=${taskId}`)
  await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })
  // Fresh attach posts an ack; reopen-after-close reuses the row + prior transcript.
  const row = page.locator(
    `[data-testid="session-row"][data-mode="minion"][data-session-id="${taskId}"]`
  )
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).not.toHaveClass(/closed/, { timeout: 30_000 })
}

/** Parse instrumented SETUP lines from this e2e userData main.log. */
function setupLogLines(userDataDir: string): string[] {
  const logPath = join(userDataDir, 'logs', 'main.log')
  let raw = ''
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((line) => line.includes('minionHarness: setup paint') || line.includes('minionHarness: setup decide') || line.includes('minionHarness: attach pre-complete') || line.includes('minionHarness: startup complete'))
}

test.describe('minion-session', () => {
  test('SETUP evidence: create must paint boot before connect (log + UI)', async () => {
    test.setTimeout(300_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-setup-log-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt =
      'Atelier e2e SETUP-log. Run `echo atelier-e2e-setup` once, then reply with exactly: SETUP-LOG-READY.'
    try {
      await createMinionWithPrompt(page, prompt)
      await expect(
        page.locator('[data-testid="minion-setup-steps"] [data-step="boot"][data-state="active"]')
      ).toBeVisible({ timeout: 60_000 })
      await page.screenshot({ path: join(artifactsDir, 'minion-setup-boot-active.png') })

      // Wait until Connect paints or SETUP is dismissed — then dump the decide/paint trail.
      await expect
        .poll(() => {
          const lines = setupLogLines(userDataDir)
          const joined = lines.join('\n')
          return (
            joined.includes('"active":"connect"') ||
            joined.includes('startup complete') ||
            joined.includes('complete_via_foldHealthy')
          )
        }, { timeout: 180_000, intervals: [1_000, 2_000] })
        .toBeTruthy()

      const lines = setupLogLines(userDataDir)
      writeFileSync(join(artifactsDir, 'minion-setup-paint-sequence.txt'), lines.join('\n') + '\n')
      const paintActives = lines
        .filter((l) => l.includes('minionHarness: setup paint'))
        .map((l) => {
          try {
            return String((JSON.parse(l) as { active?: string }).active ?? '')
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      // Evidence assertion: Boot must appear in the paint trail before Connect (if Connect paints).
      expect(paintActives, `paint trail: ${paintActives.join('→')}`).toContain('boot')
      const bootIdx = paintActives.indexOf('boot')
      const connectIdx = paintActives.indexOf('connect')
      if (connectIdx >= 0) {
        expect(bootIdx, `boot before connect; trail=${paintActives.join('→')}`).toBeGreaterThanOrEqual(0)
        expect(bootIdx, `boot before connect; trail=${paintActives.join('→')}`).toBeLessThan(connectIdx)
      }
    } finally {
      await cleanupMinionSessions(page, { cancelRemote: true })
      await app.close().catch(() => undefined)
    }
  })

  test('SETUP evidence: reattach paints Boot until worker linked (not Connect on RUNNING alone)', async () => {
    test.setTimeout(600_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-attach-setup-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const seed =
      'Atelier e2e attach-SETUP. Run `echo atelier-e2e-attach-setup` once, then reply with exactly: ATTACH-SETUP-SEED.'
    try {
      await createMinionWithPrompt(page, seed)
      await expectAssistantAnswerAfter(page, seed.slice(0, 40), 420_000)
      const taskId = await activeMinionTaskId(page)
      await closeMinionKeepRemote(page, taskId)
      const linesBeforeAttach = setupLogLines(userDataDir).length
      await attachMinionTask(page, taskId)

      // Minion UI: Boot while pod may already be RUNNING but worker not linked yet.
      await expect
        .poll(() => {
          const lines = setupLogLines(userDataDir).slice(linesBeforeAttach)
          return lines.some(
            (l) => l.includes('minionHarness: setup paint') && l.includes('"active":"boot"')
          )
        }, { timeout: 60_000, intervals: [200, 500, 1_000] })
        .toBeTruthy()

      await page.screenshot({ path: join(artifactsDir, 'minion-setup-attach.png') })
      const lines = setupLogLines(userDataDir)
      writeFileSync(join(artifactsDir, 'minion-setup-attach-sequence.txt'), lines.join('\n') + '\n')
      const after = lines.slice(linesBeforeAttach)
      const paintActives = after
        .filter((l) => l.includes('minionHarness: setup paint'))
        .map((l) => {
          try {
            return String((JSON.parse(l) as { active?: string }).active ?? '')
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      expect(paintActives, `reattach paint trail: ${paintActives.join('→') || '(none)'}`).toContain('boot')
      // Connect may follow after worker handshake — never as the first reattach paint.
      const first = paintActives[0]
      expect(first, `first reattach paint must be boot; trail=${paintActives.join('→')}`).toBe('boot')
    } finally {
      await cleanupMinionSessions(page, { cancelRemote: true })
      await app.close().catch(() => undefined)
    }
  })

  test('A: create SETUP → intermediate → answer → follow-up → intermediate → answer', async () => {
    test.setTimeout(900_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-a-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const prompt1 =
      'Atelier e2e Case A. Run `echo atelier-e2e-a1` in the shell once, then reply with exactly: A1-READY.'
    const prompt2 =
      'Atelier e2e Case A follow-up. Run `echo atelier-e2e-a2` once, then reply with exactly: A2-READY.'

    try {
      await createMinionWithPrompt(page, prompt1)
      await expect(setupCard(page)).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('minion-setup-steps')).toBeVisible()
      // Must actually enter Boot (not jump straight to Connect via runner_url).
      await expect(
        page.locator('[data-testid="minion-setup-steps"] [data-step="boot"][data-state="active"]')
      ).toBeVisible({ timeout: 30_000 })
      // Boot title is "Booting environment…" until wake/RUNNING, then "Starting DevPod…".
      await expect(setupCard(page).locator('.conversation-status-title')).toContainText(
        /Booting|Starting DevPod/i
      )
      await page.screenshot({ path: join(artifactsDir, 'minion-case-a-setup.png') })

      // After SETUP, working status is plain text above the composer (not a card).
      await expect(workingStatus(page)).toBeVisible({ timeout: 180_000 })
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-working"]')
      ).toHaveCount(0)
      await expectIntermediateBeforeDone(page, 420_000)
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-working"]')
      ).toHaveCount(0)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-a-intermediate.png') })

      await expectAssistantAnswerAfter(page, prompt1.slice(0, 48), 300_000)
      // Soft-stop must not append Done.+latest_update when fold already streamed A1
      // (MCP Tool Evaluation duplicate: answer row then Done. blob with same body).
      await expect(
        page
          .locator('[data-testid="transcript-message"][data-role="assistant"]')
          .filter({ hasText: /\bA1-READY\b/i })
      ).toHaveCount(1)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-a-answer.png') })

      await sendComposer(page, prompt2)
      await expectIntermediateBeforeDone(page, 300_000)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-a-followup-intermediate.png') })

      await expectAssistantAnswerAfter(page, prompt2.slice(0, 40), 300_000)
      // Fold owns transcript — prior A1-READY must not reappear as a twin row.
      await expect(
        page
          .locator('[data-testid="transcript-message"][data-role="assistant"]')
          .filter({ hasText: /\bA1-READY\b/i })
      ).toHaveCount(1)
      await expect(
        page
          .locator('[data-testid="transcript-message"][data-role="assistant"]')
          .filter({ hasText: /\bA2-READY\b/i })
      ).toHaveCount(1)
      // Minion UI order: … A1-READY … prompt2 … A2-READY (never prompt2 then A1).
      await expect
        .poll(async () => {
          const msgs = page.getByTestId('transcript-message')
          const n = await msgs.count()
          let i1 = -1
          let iPrompt2 = -1
          let i2 = -1
          for (let i = 0; i < n; i++) {
            const el = msgs.nth(i)
            const role = await el.getAttribute('data-role')
            const text = normalizeTranscriptText(await el.innerText())
            if (role === 'assistant' && /\ba1-ready\b/.test(text) && i1 < 0) i1 = i
            if (role === 'user' && text.includes(normalizeTranscriptText(prompt2.slice(0, 40))) && iPrompt2 < 0) {
              iPrompt2 = i
            }
            if (role === 'assistant' && /\ba2-ready\b/.test(text) && i2 < 0) i2 = i
          }
          return i1 >= 0 && iPrompt2 > i1 && i2 > iPrompt2
        }, { timeout: 30_000, intervals: [1_000, 2_000] })
        .toBeTruthy()
      // Working clears from worker_state (not stuck after answer).
      await expect(workingStatus(page)).toHaveCount(0, { timeout: 60_000 })
      await page.screenshot({ path: join(artifactsDir, 'minion-case-a-followup-answer.png') })
    } finally {
      await cleanupMinionSessions(page, { cancelRemote: true })
      await app.close().catch(() => undefined)
    }
  })

  test('B: self-seed attach history → follow-up → intermediate → answer', async () => {
    test.setTimeout(900_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-b-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const seedPrompt =
      'Atelier e2e Case B seed. Run `echo atelier-e2e-b-seed` once, then reply with exactly: B-SEED.'
    const followUp =
      'Atelier e2e Case B follow-up. Reply with exactly: B-READY. No code changes.'

    try {
      await createMinionWithPrompt(page, seedPrompt)
      await expect(setupCard(page)).toBeVisible({ timeout: 90_000 })
      await expectIntermediateBeforeDone(page, 420_000)
      await expectAssistantAnswerAfter(page, seedPrompt.slice(0, 40), 300_000)
      const taskId = await activeMinionTaskId(page)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-b-seeded.png') })

      // Keep remote DevPod; drop local session so attach must re-seed from scratch.
      await closeMinionKeepRemote(page, taskId)

      await attachMinionTask(page, taskId)
      await expectToolIntermediateVisible(page, 90_000)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-b-history.png') })

      await sendComposer(page, followUp)

      // Must CreateInteraction on the same tip — never mint a child DevPod.
      await expect(page.getByText(/Relaunching a DevPod from this job/i)).toHaveCount(0)

      // Follow-up is text-only (no shell) — seed tools already satisfy "intermediate";
      // assert the post-steer answer instead of requiring new tool cards.
      await page.screenshot({ path: join(artifactsDir, 'minion-case-b-followup-intermediate.png') })

      // After the follow-up user turn — require B-READY (not B-SEED from history).
      await expect
        .poll(
          async () => {
            const needle = normalizeTranscriptText(followUp.slice(0, 40))
            const msgs = page.getByTestId('transcript-message')
            const count = await msgs.count()
            let seenUser = false
            for (let i = 0; i < count; i++) {
              const el = msgs.nth(i)
              const role = await el.getAttribute('data-role')
              const text = normalizeTranscriptText(await el.innerText())
              if (!seenUser) {
                if (role === 'user' && text.includes(needle)) seenUser = true
                continue
              }
              if (role === 'assistant' && /\bb-ready\b/i.test(text)) return true
            }
            return false
          },
          { timeout: 300_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBeTruthy()
      await page.screenshot({ path: join(artifactsDir, 'minion-case-b-followup-answer.png') })
    } finally {
      await cleanupMinionSessions(page, { cancelRemote: true })
      await app.close().catch(() => undefined)
    }
  })

  // Case C parked — Features/minion-working-chrome-stall/spec.md

  test('D: re-attach open session keeps history and does not mint a twin', async () => {
    test.setTimeout(600_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-d-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const seedPrompt =
      'Atelier e2e Case D. Run `echo atelier-e2e-d` once, then reply with exactly: D-READY.'

    try {
      await createMinionWithPrompt(page, seedPrompt)
      await expect(setupCard(page)).toBeVisible({ timeout: 90_000 })
      await expectIntermediateBeforeDone(page, 420_000)
      const taskId = await activeMinionTaskId(page)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-d-history.png') })

      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      await page.getByTestId('minion-attach-link').fill(`https://minion.uberinternal.com/v2/${taskId}`)
      await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 15_000 })

      await expect(page.locator('[data-testid="session-row"][data-mode="minion"]')).toHaveCount(1)
      await expect(page.getByText(/spinning up a DevPod/i)).toHaveCount(1) // original create ack only
      await expectToolIntermediateVisible(page, 15_000)
      await page.screenshot({ path: join(artifactsDir, 'minion-case-d-reattach.png') })
    } finally {
      await cleanupMinionSessions(page, { cancelRemote: true })
      await app.close().catch(() => undefined)
    }
  })
})
