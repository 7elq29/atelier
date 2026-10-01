/**
 * Timeline DnD: 15-minute snap + hour-label / gridline alignment.
 *
 * Reproduces:
 * 1. Schedule create/drop snapped to half-hours (or agenda to whole hours)
 *    instead of SNAP_MINUTES=15.
 * 2. Left hour labels not sharing the same Y as their horizontal gridlines.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

test.describe('timeline DnD: 15-min snap and hour-label alignment', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-timeline-dnd-15-'))
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-timeline-dnd-15-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(
      notePath,
      `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## 📋 Tasks\n\n### ⚪ Backlog\n\n- [ ] Drop onto schedule\n\n### 🤝 Delegated\n-\n`,
      'utf-8'
    )

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('agenda drag ghost snaps to a 15-minute start, not a whole hour', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible()
    const box = await agenda.boundingBox()
    if (!box) throw new Error('agenda not visible')

    const taskId = await page.locator('[data-testid="unscheduled-task"]').first().getAttribute('data-task-id')
    if (!taskId) throw new Error('missing unscheduled task')

    // 9:00 is hour index 3. Drop 22.5 minutes into the hour (≈ 9:22.5 → snaps to 9:15).
    // During dragover the overlay expands to fill agenda height, so use that pitch.
    const clientY = await page.evaluate(({ agendaTop, taskId: id }) => {
      const agendaEl = document.querySelector('[data-testid="timeline-agenda"]') as HTMLElement
      const hours = 16
      // Fire a priming dragover so :has() expand + layout effect run, then read height.
      const dt = new DataTransfer()
      dt.setData('text/task-id', id)
      agendaEl.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 100, clientY: agendaTop + 10 })
      )
      const slotH = Math.max(36, agendaEl.clientHeight / hours)
      // 3 hours + 22.5 minutes into the expanded grid
      return agendaTop + (3 + 22.5 / 60) * slotH
    }, { agendaTop: box.y, taskId })

    await page.evaluate(({ id, clientY: y }) => {
      const target = document.querySelector('[data-testid="timeline-agenda"]')!
      const dt = new DataTransfer()
      dt.setData('text/task-id', id)
      dt.setData('text/task-label', 'Drop onto schedule')
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 100, clientY: y })
      )
    }, { id: taskId, clientY })

    const ghost = page.locator('[data-testid="agenda-drag-ghost"]')
    await expect(ghost).toBeVisible()
    await expect(ghost).toHaveAttribute('data-start-min', '555') // 9:15 = 9*60+15
    await expect(page.locator('.dn-agenda-ghost-label')).toContainText('9:15')

    await page.screenshot({ path: join(artifactsDir, 'timeline-dnd-agenda-15min-ghost.png') })

    await page.evaluate(() => {
      document.querySelector('[data-testid="timeline-agenda"]')!
        .dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    })
  })

  test('schedule hour labels share Y with their gridlines; right-click snaps to 15 minutes', async () => {
    await page.getByTestId('timeline-open-schedule').click()
    await expect(page.getByTestId('timeline-body')).toBeVisible()

    const alignment = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.dn-hour-row'))
      return rows.slice(0, 5).map((row) => {
        const label = row.querySelector('.dn-hour-label') as HTMLElement | null
        const line = row.querySelector('.dn-hour-line') as HTMLElement | null
        if (!label || !line) return null
        const lr = label.getBoundingClientRect()
        const ln = line.getBoundingClientRect()
        return {
          labelCenterY: lr.top + lr.height / 2,
          lineCenterY: ln.top + ln.height / 2,
          delta: Math.abs(lr.top + lr.height / 2 - (ln.top + ln.height / 2))
        }
      }).filter(Boolean)
    })
    expect(alignment.length).toBeGreaterThan(0)
    for (const row of alignment) {
      expect(row!.delta, 'label center should match line center').toBeLessThanOrEqual(1.5)
    }

    const timelineBody = page.locator('[data-testid="timeline-body"]')
    // y=75 → raw 360+75=435 → snapMinutes → 435 (07:15). Duration 30 → 07:15–07:45.
    await timelineBody.click({ button: 'right', position: { x: 40, y: 75 } })
    const input = page.getByTestId('timeline-new-task-input')
    await expect(input).toBeVisible()
    await expect(page.getByTestId('timeline-draft-range')).toHaveText(/07:15[–-]07:45/)
    await input.fill('Fifteen-minute snap task')
    await input.press('Enter')

    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Fifteen-minute snap task' })).toBeVisible()
    await page.waitForTimeout(1200)
    const content = readFileSync(notePath, 'utf-8')
    expect(content).toMatch(/07:15[–-]07:45\s+Fifteen-minute snap task/)

    await page.screenshot({ path: join(artifactsDir, 'timeline-dnd-schedule-15min-align.png') })
  })
})
