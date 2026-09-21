/**
 * Diagnostic test for: time-edit card always reverts to 30 min.
 *
 * Root observation: clicking the time label of a scheduled task opens a
 * time-edit card (dur-card). The user scrolls to change the duration.
 * Clicking outside the card to "confirm" actually DISCARDS the change
 * (click-outside handler calls setTimeEdit(null) instead of commitTimeEdit()).
 * Only pressing Enter saves. So any duration change made via scroll is lost
 * unless the user knows to press Enter, making the task always revert to
 * whatever its original duration was (usually the 30-min default).
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

// A note with one scheduled task with a 30-min time block
const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 9:00-9:30 Standup

### ⚪ Backlog

### 🤝 Delegated
-
`

test.describe('bug-agenda-duration-save', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-dur-save-'))
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-dur-save-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')

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

  test('BUG: clicking outside time-edit card DISCARDS duration change (expected: should save)', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 5_000 })

    // Find the scheduled task in AgendaTimeline (uses data-testid="agenda-task")
    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 5_000 })

    // Click the time label (.dn-agenda-time--editable) to open the time-edit card
    const timeLabel = task.locator('.dn-agenda-time--editable')
    await expect(timeLabel).toBeVisible()
    console.log(`[DUR BUG] Time label text: "${await timeLabel.textContent()}"`)
    await timeLabel.click()
    await page.waitForTimeout(200)

    // Check if a dur-card appeared
    const durCard = page.locator('.dn-dur-card')
    const cardNowVisible = await durCard.isVisible()
    console.log(`[DUR BUG] Time-edit card visible after click: ${cardNowVisible}`)
    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-duration-save-1-card-open.png') })

    if (!cardNowVisible) {
      console.log('[DUR BUG] Could not open time-edit card — skipping duration change')
      return
    }

    // Read the initial duration shown in the card
    const durValue = await durCard.locator('.dn-dur-card-num').textContent()
    const durUnit = await durCard.locator('.dn-dur-card-unit').textContent()
    console.log(`[DUR BUG] Card shows initial duration: ${durValue} ${durUnit}`)

    // Scroll UP to increase duration (e.g. from 30 → 45 min)
    await page.evaluate(() => {
      const card = document.querySelector('.dn-dur-card')
      if (!card) return
      card.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(100)

    const durAfterScroll = await durCard.locator('.dn-dur-card-num').textContent()
    const unitAfterScroll = await durCard.locator('.dn-dur-card-unit').textContent()
    console.log(`[DUR BUG] Card shows duration after scroll: ${durAfterScroll} ${unitAfterScroll}`)
    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-duration-save-2-scrolled.png') })

    // Now click OUTSIDE the card (simulating user clicking away to "confirm")
    await page.mouse.click(10, 10)
    await page.waitForTimeout(300)

    const cardGone = !(await durCard.isVisible())
    console.log(`[DUR BUG] Card dismissed: ${cardGone}`)

    // Check if the task's time block was updated on disk
    await page.waitForTimeout(1000)
    const fileContent = readFileSync(notePath, 'utf-8')
    const taskLine = fileContent.split('\n').find(l => l.includes('Standup'))
    console.log(`[DUR BUG] Task line in file after click-outside: "${taskLine}"`)
    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-duration-save-3-after-dismiss.png') })

    // The bug: duration should have changed but it won't have,
    // because click-outside discards without saving.
    const stillHas30min = taskLine?.includes('9:00-9:30')
    console.log(`[DUR BUG] Duration was changed in card to: ${durAfterScroll} ${unitAfterScroll}`)
    console.log(`[DUR BUG] Task still has original 30-min block (9:00-9:30): ${stillHas30min}`)
    console.log(`[DUR BUG] BUG CONFIRMED: ${stillHas30min ? 'YES - click-outside discarded the change' : 'NO - change was saved'}`)

    // This assertion documents the bug: after scrolling to change duration and
    // clicking outside, the file should show the new duration, but it doesn't.
    expect(stillHas30min, 'clicking outside time-edit card should save the new duration, not discard it').toBe(false)
  })

  test('VERIFY: pressing Enter in time-edit card DOES save the duration change', async () => {
    // Reset note to original
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')
    await page.waitForTimeout(500) // let file watcher re-sync

    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 5_000 })

    // Open time-edit card by clicking the time label
    await task.locator('.dn-agenda-time--editable').click()
    await page.waitForTimeout(200)

    const durCard = page.locator('.dn-dur-card')
    if (!(await durCard.isVisible())) {
      console.log('[DUR BUG] Could not open time-edit card for Enter test')
      return
    }

    // Scroll to change duration
    await page.evaluate(() => {
      const card = document.querySelector('.dn-dur-card')
      if (!card) return
      card.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(100)

    const durAfterScroll = await durCard.locator('.dn-dur-card-num').textContent()
    const unitAfterScroll = await durCard.locator('.dn-dur-card-unit').textContent()
    console.log(`[DUR BUG ENTER] Duration after scroll: ${durAfterScroll} ${unitAfterScroll}`)

    // Focus the card explicitly before pressing Enter (autoFocus may have shifted)
    await durCard.focus()
    // Press Enter to confirm
    await page.keyboard.press('Enter')
    // Wait well past the 500ms write debounce
    await page.waitForTimeout(1500)

    const fileContent = readFileSync(notePath, 'utf-8')
    const taskLine = fileContent.split('\n').find(l => l.includes('Standup'))
    console.log(`[DUR BUG ENTER] Task line after Enter: "${taskLine}"`)

    // Enter should save - task should NOT be 9:00-9:30 anymore
    expect(taskLine, 'Enter should save the new duration').not.toMatch(/9:00-9:30/)
  })
})
