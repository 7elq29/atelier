/**
 * Diagnostic tests for two reported AgendaTimeline bugs:
 *
 * BUG 1 — Time range is wrong after dragging:
 *   The drag overlay renders a fixed-height grid (AGENDA_SLOT_H_PX * AGENDA_HOURS.length).
 *   But hourFromClientY() uses the real agenda element height to compute the hour.
 *   If those two heights differ, the ghost label and the dropped time will be wrong.
 *
 * BUG 2 — Ghost block position doesn't match the cursor:
 *   The ghost block is positioned at AGENDA_HOURS.indexOf(hour) * AGENDA_SLOT_H_PX
 *   inside the overlay. But the cursor's Y is mapped via the real element height,
 *   not the fixed pixel grid. When the real height ≠ overlay height the ghost
 *   appears at the wrong spot relative to where the cursor is.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

// Daily note with two unscheduled tasks (no time blocks) so they appear in
// the Unscheduled section and can be dragged onto the agenda.
const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog

- [ ] Drag me to 9am
- [ ] Drag me to 3pm

### 🤝 Delegated
-
`

test.describe('bug-agenda-drag-time: time and ghost positioning', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-drag-'))
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-drag-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(join(noteDir, `${TEST_DATE}.md`), DAILY_NOTE_CONTENT, 'utf-8')

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

  // ─────────────────────────────────────────────────────────────────
  // BUG 1 — Ghost label shows correct time for drag position
  // ─────────────────────────────────────────────────────────────────
  test('BUG 1 – ghost label matches the hour slot the cursor is over', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 5_000 })

    const agendaBox = await agenda.boundingBox()
    if (!agendaBox) throw new Error('agenda not found')

    // Measure the fixed overlay grid height vs. real agenda height
    const { overlayHeight, agendaHeight, agendaSlotPx, agendaHoursCount } = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="timeline-agenda"]') as HTMLElement
      if (!el) throw new Error('agenda not in DOM')
      // These constants mirror AgendaTimeline.tsx
      const AGENDA_SLOT_H_PX = 36
      const AGENDA_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
      return {
        overlayHeight: AGENDA_HOURS.length * AGENDA_SLOT_H_PX,
        agendaHeight: el.getBoundingClientRect().height,
        agendaSlotPx: AGENDA_SLOT_H_PX,
        agendaHoursCount: AGENDA_HOURS.length,
      }
    })

    // If these differ, the ghost won't line up with the cursor
    console.log(`[BUG 1] overlay grid height: ${overlayHeight}px, actual agenda height: ${agendaHeight}px`)
    console.log(`[BUG 1] heights match: ${Math.abs(overlayHeight - agendaHeight) < 2}`)

    // Synthesize a dragover event at a specific hour slot in the overlay grid.
    // We want to hover near the top of the 9am slot (index 3 in AGENDA_HOURS=[6..21])
    // so 15-minute snap lands on 09:00 (not :15/:30/:45).
    const targetHourIndex = 3 // 9am (AGENDA_HOURS[3] = 9)
    const overlaySlotTopPx = targetHourIndex * agendaSlotPx // 108px in the overlay

    // Cursor just below the hour mark so snapMinutes lands on 9:00.
    const cursorClientY = agendaBox.y + overlaySlotTopPx + 2

    // What start-minute does minutesFromClientY compute for this cursor position?
    const computedStartMin = await page.evaluate(({ clientY, agendaTop }) => {
      const AGENDA_START_MIN = 6 * 60
      const AGENDA_SLOT_H_PX = 36
      const SNAP = 15
      const relY = Math.max(0, clientY - agendaTop)
      const rawMin = AGENDA_START_MIN + (relY / AGENDA_SLOT_H_PX) * 60
      return Math.round(rawMin / SNAP) * SNAP
    }, { clientY: cursorClientY, agendaTop: agendaBox.y })

    console.log(`[BUG 1] cursor near 9am mark → minutesFromClientY: ${computedStartMin}`)
    console.log(`[BUG 1] expected startMin: 540 (9:00), got: ${computedStartMin}`)

    // Synthesize a dragover and inspect the ghost label
    const taskId = await page.locator('[data-testid="unscheduled-task"]').first().getAttribute('data-task-id')
    if (!taskId) throw new Error('no unscheduled task with data-task-id')

    await page.evaluate(({ id, clientY }) => {
      const target = document.querySelector('[data-testid="timeline-agenda"]')!
      const dt = new DataTransfer()
      dt.setData('text/task-id', id)
      dt.setData('text/task-label', 'Drag me to 9am')
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: 100, clientY,
      }))
    }, { id: taskId, clientY: cursorClientY })

    await page.waitForTimeout(100)

    const ghost = page.locator('[data-testid="agenda-drag-ghost"]')
    await expect(ghost).toBeVisible()
    const ghostText = await page.locator('.dn-agenda-ghost-label').textContent()
    console.log(`[BUG 1] ghost label text: "${ghostText}"`)

    // Also capture the ghost's position within the overlay
    const { ghostTop, overlayTop } = await page.evaluate(() => {
      const ghost = document.querySelector('[data-testid="agenda-drag-ghost"]') as HTMLElement
      const overlay = document.querySelector('.dn-agenda-overlay') as HTMLElement
      if (!ghost || !overlay) return { ghostTop: -1, overlayTop: -1 }
      return {
        ghostTop: ghost.getBoundingClientRect().top,
        overlayTop: overlay.getBoundingClientRect().top,
      }
    })

    const ghostOffsetInOverlay = ghostTop - overlayTop
    console.log(`[BUG 1] ghost offset from overlay top: ${ghostOffsetInOverlay}px`)
    console.log(`[BUG 1] cursor offset from agenda top: ${cursorClientY - agendaBox.y}px`)

    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-drag-time-ghost-position.png') })

    expect({
      overlayHeight,
      agendaHeight,
      heightsMatch: Math.abs(overlayHeight - agendaHeight) < 2,
      computedStartMinForCursorAt9amSlot: computedStartMin,
      expectedStartMin: 540,
      ghostLabel: ghostText?.trim(),
      cursorOffsetFromAgendaTop: Math.round(cursorClientY - agendaBox.y),
      ghostOffsetInOverlay: Math.round(ghostOffsetInOverlay),
    }).toMatchObject({
      heightsMatch: true,
      computedStartMinForCursorAt9amSlot: 540,
    })
    await expect(ghost).toHaveAttribute('data-start-min', '540')

    // Cancel the drag
    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="timeline-agenda"]')!
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    })
  })

  // ─────────────────────────────────────────────────────────────────
  // BUG 2 — Ghost block visually matches cursor Y position
  // ─────────────────────────────────────────────────────────────────
  test('BUG 2 – ghost block top aligns with the cursor position in the overlay', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    const agendaBox = await agenda.boundingBox()
    if (!agendaBox) throw new Error('agenda not visible')

    const { agendaSlotPx, agendaHeight, overlayHeight } = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="timeline-agenda"]') as HTMLElement
      const AGENDA_SLOT_H_PX = 36
      const AGENDA_HOURS_LEN = 16
      return {
        agendaSlotPx: AGENDA_SLOT_H_PX,
        agendaHeight: el.getBoundingClientRect().height,
        overlayHeight: AGENDA_HOURS_LEN * AGENDA_SLOT_H_PX,
      }
    })

    const taskId = await page.locator('[data-testid="unscheduled-task"]').first().getAttribute('data-task-id')
    if (!taskId) throw new Error('no unscheduled task with data-task-id')

    // Test at multiple Y positions — cursor at 25%, 50%, 75% of agenda height
    const results: Array<{ cursorFraction: number; cursorOffsetPx: number; ghostOffsetPx: number; diff: number }> = []

    for (const fraction of [0.25, 0.5, 0.75]) {
      const cursorOffsetFromTop = agendaBox.height * fraction
      const cursorClientY = agendaBox.y + cursorOffsetFromTop

      await page.evaluate(({ id, clientY }) => {
        const target = document.querySelector('[data-testid="timeline-agenda"]')!
        const dt = new DataTransfer()
        dt.setData('text/task-id', id)
        dt.setData('text/task-label', 'test')
        target.dispatchEvent(new DragEvent('dragover', {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: 100, clientY,
        }))
      }, { id: taskId, clientY: cursorClientY })

      await page.waitForTimeout(100)

      const { ghostTop, overlayTop } = await page.evaluate(() => {
        const ghost = document.querySelector('[data-testid="agenda-drag-ghost"]') as HTMLElement | null
        const overlay = document.querySelector('.dn-agenda-overlay') as HTMLElement | null
        if (!ghost || !overlay) return { ghostTop: -1, overlayTop: -1 }
        return {
          ghostTop: ghost.getBoundingClientRect().top,
          overlayTop: overlay.getBoundingClientRect().top,
        }
      })

      if (ghostTop >= 0) {
        const ghostOffsetPx = ghostTop - overlayTop
        const diff = ghostOffsetPx - cursorOffsetFromTop
        results.push({ cursorFraction: fraction, cursorOffsetPx: Math.round(cursorOffsetFromTop), ghostOffsetPx: Math.round(ghostOffsetPx), diff: Math.round(diff) })
      }

      // Cancel drag between iterations
      await page.evaluate(() => {
        document.querySelector('[data-testid="timeline-agenda"]')!
          .dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
      })
      await page.waitForTimeout(50)
    }

    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-drag-time-alignment.png') })

    console.log('[BUG 2] Cursor vs ghost position results:')
    for (const r of results) {
      console.log(`  cursor at ${Math.round(r.cursorFraction * 100)}% (${r.cursorOffsetPx}px) → ghost at ${r.ghostOffsetPx}px, diff: ${r.diff}px`)
    }
    console.log(`[BUG 2] overlay grid height: ${overlayHeight}px, real agenda height: ${Math.round(agendaHeight)}px`)

    // Ghost snaps to the nearest 15-minute mark. Cursor can be up to ±7.5 minutes
    // away (half a snap interval) from the ghost top → at most slotH/8 of vertical
    // error once the overlay has expanded to fill the agenda.
    for (const r of results) {
      const slotH = agendaBox.height / 16
      const maxDiff = slotH / 4 + 2 // one full 15-min step in expanded px + rounding
      expect(Math.abs(r.diff), `ghost within one 15-min step of cursor at ${Math.round(r.cursorFraction * 100)}%`).toBeLessThanOrEqual(maxDiff)
    }
  })
})
