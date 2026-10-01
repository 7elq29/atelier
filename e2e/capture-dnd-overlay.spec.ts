/**
 * Capture a zoomed screenshot of the agenda drag overlay so we can
 * visually inspect readability of hour labels vs ghost chip.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

test('capture agenda drag overlay close-up', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-dnd-shot-'))
  seedSkipOnboarding(userDataDir)
  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-dnd-shot-vault-'))
  const vaultRoot = join(vaultParent, 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  writeFileSync(
    join(noteDir, `${TEST_DATE}.md`),
    `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## 📋 Tasks\n\n### ⚪ Backlog\n\n- [ ] Drop onto schedule\n- [ ] Another task for density\n\n### 🤝 Delegated\n-\n`,
    'utf-8'
  )

  const electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })

  const agenda = page.locator('[data-testid="timeline-agenda"]')
  await expect(agenda).toBeVisible()
  const box = await agenda.boundingBox()
  if (!box) throw new Error('agenda missing')

  const taskId = await page.locator('[data-testid="unscheduled-task"]').first().getAttribute('data-task-id')
  if (!taskId) throw new Error('no task')

  // Hover mid 9am slot after expand so we get a representative ghost.
  const clientY = await page.evaluate(({ agendaTop, id }) => {
    const el = document.querySelector('[data-testid="timeline-agenda"]') as HTMLElement
    const dt = new DataTransfer()
    dt.setData('text/task-id', id)
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 100, clientY: agendaTop + 40 }))
    const slotH = Math.max(36, el.clientHeight / 16)
    return agendaTop + (3 + 0.4) * slotH // ~9:24 → snaps to 9:15 or 9:30
  }, { agendaTop: box.y, id: taskId })

  await page.evaluate(({ id, clientY: y }) => {
    const target = document.querySelector('[data-testid="timeline-agenda"]')!
    const dt = new DataTransfer()
    dt.setData('text/task-id', id)
    dt.setData('text/task-label', 'Drop onto schedule')
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: boxCenterX(), clientY: y }))
    function boxCenterX() {
      const r = target.getBoundingClientRect()
      return r.left + r.width / 2
    }
  }, { id: taskId, clientY })

  await expect(page.locator('[data-testid="agenda-drag-ghost"]')).toBeVisible()

  await page.screenshot({ path: join(artifactsDir, 'dnd-overlay-full.png') })

  const panel = page.locator('[data-testid="daily-notes-panel"]')
  await panel.screenshot({ path: join(artifactsDir, 'dnd-overlay-panel.png') })

  // Crop to the overlay region around the ghost.
  const overlay = page.locator('.dn-agenda-overlay')
  await overlay.screenshot({ path: join(artifactsDir, 'dnd-overlay-closeup.png') })

  await electronApp.close()
})
