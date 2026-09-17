import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Repro + fix confirmation for "fix-note-content-reverts-to-template-on-edit".
 *
 * User report: "when I move a task from unscheduled task to the timeline,
 * all existing content in daily note are replaced by the template."
 *
 * Root cause (see vault doc
 * Bugs/fix-note-content-reverts-to-template-on-edit/context.md): a race
 * between note creation and the fs.watch live-sync pipeline.
 *
 *   1. `daily-note:create` writes the new note file.
 *   2. The renderer immediately arms `watchDailyNote(date)`.
 *   3. Within ~10ms, a stale/self-triggered fs.watch event fires for that
 *      very creation write (a known macOS FSEvents quirk).
 *   4. That schedules the watcher's 300ms-debounced reparse
 *      (`WATCH_DEBOUNCE_MS` in daily-notes-handlers.ts).
 *   5. Meanwhile the user's edit (add/move a task) updates in-memory state
 *      and schedules its own 500ms-debounced write (`WRITE_DEBOUNCE_MS` in
 *      useDailyNote.ts).
 *   6. The watcher's 300ms timer fires first, reads the file (still the bare
 *      just-created content), and pushes it via `daily-note:changed`.
 *   7. `onDailyNoteChanged` unconditionally overwrites in-memory state with
 *      the stale snapshot AND cancels the pending write — the edit is lost.
 *
 * This spec creates a note via the real UI (`create-daily-note`), then
 * WITHOUT any artificial delay immediately adds a task to Unscheduled and
 * drags it onto the Timeline, then waits through both debounce windows and
 * asserts the task survived, both in the UI and in the on-disk file.
 *
 * Must FAIL on unfixed code (the added/moved task vanishes, reverted to the
 * bare just-created template) and PASS after the self-write echo suppression
 * fix in daily-notes-handlers.ts.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const TEST_DATE = '2026-07-30'

test.describe('fix-confirmed: newly-created note survives an immediate task add + drag-to-timeline edit', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-immediate-edit-'))
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-immediate-edit-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    // No template seeded — falls back to the built-in skeleton; irrelevant to
    // this race, which reproduces regardless of what generateNewNote emits.
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    // TEST_DATE's note is deliberately NOT created yet — the create flow
    // itself, exercised via the real UI below, is what arms the race.

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

  test('create note, then immediately add + drag a task to the Timeline: edit survives both debounce windows', async () => {
    const createButton = page.locator('[data-testid="create-daily-note"]')
    await expect(createButton).toBeVisible()
    await createButton.click()

    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible()
    await expect(page.getByTestId('dn-focus-summary')).toHaveText('Daily three')
    await expect(page.getByText('No priorities yet')).toBeVisible()
    await expect(page.getByTestId('dn-big-three-edit')).toHaveAttribute('aria-label', "Add today's priorities")
    await expect(page.getByTestId('trackers-section')).toHaveCount(0)
    await page.getByTestId('timeline-open-schedule').click()
    await expect(page.getByTestId('timeline-body')).toBeVisible()

    // No artificial delay here — this is the whole point of the repro: the
    // edit must land while the watcher's self-triggered creation echo is
    // still in-flight (well under its 300ms debounce).
    await page.locator('[data-testid="add-unscheduled-task-btn"]').click()
    const input = page.locator('[data-testid="add-unscheduled-task-input"]')
    await expect(input).toBeVisible()
    await input.fill('Ship the race-condition fix')
    await input.press('Enter')

    const chip = page.locator('[data-testid="unscheduled-task"]', { hasText: 'Ship the race-condition fix' })
    await expect(chip).toBeVisible()
    const taskId = await chip.getAttribute('data-task-id')
    expect(taskId).toBeTruthy()

    // Immediately drag it onto the timeline (synthetic DragEvent, same
    // pattern as obsidian-integration.spec.ts's Unscheduled -> Timeline
    // test), again with no artificial delay.
    await page.evaluate((id) => {
      const target = document.querySelector('[data-testid="timeline-body"]')
      if (!target) throw new Error('timeline body not found')
      const dt = new DataTransfer()
      dt.setData('text/task-id', id as string)
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, taskId)

    // Wait through both the 300ms watcher debounce and the 500ms write
    // debounce, comfortably (1.5s total).
    await page.waitForTimeout(1500)

    // UI must still show the task (on the timeline now, not reverted away).
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Ship the race-condition fix' })).toBeVisible()
    await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Ship the race-condition fix' })).toHaveCount(0)

    // On-disk file must contain the task too — not reverted to the bare
    // just-created template.
    const content = readFileSync(notePath, 'utf-8')
    expect(content).toContain('Ship the race-condition fix')
  })
})
