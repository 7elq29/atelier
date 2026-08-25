import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const GID_STANDUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function seedFixtureContent(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:15 Standup [gid:: ${GID_STANDUP}]
`
}

async function queryDb<T>(page: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return page.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

async function openCreateSessionFromStandup(page: Page): Promise<void> {
  const task = page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })
  await expect(task).toBeVisible()
  const box = await task.boundingBox()
  if (!box) throw new Error('task not visible')
  await task.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
  await page.getByTestId('task-create-session-option').click()
}

async function finishTerminalSessionModal(page: Page, projectPath: string): Promise<void> {
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('mode-terminal').click()
  await page.getByTestId('project-path').fill(projectPath)
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).not.toBeVisible({ timeout: 15_000 })
}

test.describe('todo-session-link: task context menu creates linked session', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let notePath: string
  let projectPath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-todo-session-link-'))
    projectPath = mkdtempSync(join(tmpdir(), 'atelier-e2e-project-'))
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
    const vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(notePath, seedFixtureContent(), 'utf-8')

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ATELIER_TEST_VAULT_ROOT: vaultRoot,
        ATELIER_TEST_DATE: TEST_DATE
      }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('create link, replace confirmation, and delete-with-complete flow', async () => {
    await openCreateSessionFromStandup(page)
    await finishTerminalSessionModal(page, projectPath)
    await page.screenshot({ path: join(artifactsDir, 'todo-session-link-created.png') })

    let rows = await queryDb<{ id: string; linked_daily_task_gid: string; linked_daily_note_date: string }>(
      page,
      `SELECT id, linked_daily_task_gid, linked_daily_note_date FROM sessions WHERE linked_daily_task_gid IS NOT NULL`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.linked_daily_task_gid).toBe(GID_STANDUP)
    expect(rows[0]!.linked_daily_note_date).toBe(TEST_DATE)
    const sessionId = rows[0]!.id

    let onDisk = readFileSync(notePath, 'utf-8')
    expect(onDisk).toContain(`[session:: ${sessionId}]`)

    await openCreateSessionFromStandup(page)
    await expect(page.getByTestId('task-session-replace-dialog')).toBeVisible()
    await page.getByTestId('task-session-replace-cancel').click()
    await expect(page.getByTestId('task-session-replace-dialog')).not.toBeVisible()
    await expect(page.getByTestId('new-session-modal')).not.toBeVisible()

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(row).toBeVisible()
    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-delete').click()

    await expect(page.getByTestId('delete-session-linked-task-dialog')).toBeVisible()
    await page.getByTestId('delete-linked-confirm').click()
    await expect(page.getByTestId('delete-session-linked-task-dialog')).not.toBeVisible()

    onDisk = readFileSync(notePath, 'utf-8')
    expect(onDisk).toMatch(/- \[x\].*Standup/)

    rows = await queryDb<{ id: string }>(page, `SELECT id FROM sessions WHERE id = ?`, [sessionId])
    expect(rows).toHaveLength(0)

    await page.screenshot({ path: join(artifactsDir, 'todo-session-link-deleted-complete.png') })
  })
})
