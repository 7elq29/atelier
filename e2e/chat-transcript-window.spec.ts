import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function execDb(page: Page, sql: string, params: unknown[] = []): Promise<void> {
  await page.evaluate(
    ({ query, bindings }) => window.atelier.debugExecDb(query, bindings),
    { query: sql, bindings: params }
  )
}

async function seedUserTurns(page: Page, sessionId: string, count: number): Promise<void> {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  for (let i = 1; i <= count; i++) {
    const userAt = new Date(base + i * 2000).toISOString()
    const assistantAt = new Date(base + i * 2000 + 1000).toISOString()
    await execDb(
      page,
      `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, 'user', ?, NULL, ?)`,
      [sessionId, `seed-turn-${i}-user`, userAt]
    )
    await execDb(
      page,
      `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, 'assistant', ?, NULL, ?)`,
      [sessionId, `seed-turn-${i}-assistant`, assistantAt]
    )
  }
}

test.describe('chat-transcript-window', () => {
  test('shows only the last 40 conversations with a truncation banner', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-transcript-window-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-transcript-project-'))

    const { app, page } = await launchApp(userDataDir)

    const sessionId = await page.evaluate(async (cwd) => {
      const session = await window.atelier.createSession({
        projectPath: cwd,
        mode: 'claude-code',
        hostId: 'local',
        suggestedName: 'Transcript window'
      })
      return session.id
    }, projectDir)

    await seedUserTurns(page, sessionId, 41)

    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()

    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('transcript-history-truncated')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('transcript-history-truncated')).toContainText('40 conversations')
    await expect(page.getByTestId('transcript-history-truncated')).toContainText('1 earlier hidden')

    await expect(page.locator('[data-testid="transcript-message"]').filter({ hasText: 'seed-turn-1-user' })).toHaveCount(0)
    await expect(page.locator('[data-testid="transcript-message"]').filter({ hasText: 'seed-turn-41-user' })).toHaveCount(1)

    const result = await page.evaluate((id) => window.atelier.listSessionMessages(id), sessionId)
    expect(result.transcriptTruncated).toBe(true)
    expect(result.hiddenTurnCount).toBe(1)
    expect(result.messages.filter((m) => m.role === 'user').length).toBe(40)

    await page.screenshot({ path: join(artifactsDir, 'chat-transcript-window-41-turns.png') })

    await app.close()
  })
})
