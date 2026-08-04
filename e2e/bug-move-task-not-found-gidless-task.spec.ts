import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Acceptance test for fix-gidless-task-id-not-persisted (see
 * Documents/Default/03.projects/Gardenia/Bugs/fix-gidless-task-id-not-persisted/spec.md
 * and the root-cause investigation it references,
 * Documents/Default/03.projects/Gardenia/Bugs/fix-move-task-not-found-root-cause/spec.md).
 *
 * Root cause: `daily-note-io.ts`'s `parseDailyNote` minted a brand-new random
 * `gid` (`mintTaskId()`) EVERY time it parsed a task line with no `[gid::]`
 * tag, and nothing persisted that minted id back to disk until some renderer
 * mutation happened to round-trip it. A task hand-typed directly in Obsidian
 * (never touched via Gardenia's UI) would therefore get a different,
 * independently-minted id on every separate parse — including
 * `daily-notes-handlers.ts`'s own fresh re-parse inside the
 * `daily-note:move-task` handler, decoupled from whatever id the renderer's
 * `tasks` state currently held. That made `daily-note:move-task` fail
 * deterministically with "task not found in source note: <id>" for any
 * gid-less task, with no external edit, no race window, and no stale menu
 * required.
 *
 * This spec previously reproduced that failure (see git history — the
 * original two "reproduction"/"confirms the existing mitigation" tests
 * asserted the error). The fix persists a minted `[gid:: ...]` back to disk
 * the FIRST time a gid-less task line is parsed (daily-note:read,
 * ensureNoteExists, the fs.watch reparse, and move-task's own source parse
 * all now call `persistMintedGids`), so every subsequent parse of the same
 * file — including `daily-note:move-task`'s own independent re-parse —
 * reuses the SAME id instead of minting a new random one. This spec is now
 * the acceptance test: the exact same gid-less-task scenario must succeed
 * the move instead of throwing.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-08-03' // Monday, week 32 — same convention as the sibling spec
const TOMORROW = '2026-08-04'

/** A task line with NO `[gid::]` tag — exactly what a hand-typed Obsidian
 * task, or a task carried from the vault template, looks like before it's
 * ever been touched by Gardenia's own mutate/write path. */
function gidlessSeedContent(): string {
  return `---
date: ${TEST_DATE}
day: Monday
type: daily
---

## 📋 Tasks

- [ ] 09:15 - 10:00 Add high urgency alerts for ingestion lag

### ⚪ Backlog
-

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker
`
}

test.describe('fix-gidless-task-id-not-persisted: moving a task that has never had a persisted gid now succeeds', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-gidless-userdata-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-gidless-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(notePath, gidlessSeedContent(), 'utf-8')

    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, GARDENIA_TEST_VAULT_ROOT: vaultRoot, GARDENIA_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('the initial daily-note:read persists a minted gid for the gid-less task before the move menu is ever opened', async () => {
    // The seed file was written with NO gid tag (see gidlessSeedContent) —
    // by the time the Timeline renders the task below, the app's very first
    // daily-note:read has already run and (per the fix) persisted a minted
    // [gid::] back to disk. We can't observe the pre-persist on-disk state
    // from here (the read/persist round-trip completes before the renderer
    // even paints), so this test instead asserts the post-persist invariant
    // directly: the on-disk file now has a gid for a task that started with
    // none — proving persist-on-first-parse actually ran.
    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'ingestion lag' })
    await expect(timelineTask).toBeVisible()

    // The read that populated the Timeline should have persisted a [gid::]
    // tag back to disk immediately — the fix's core invariant. Poll briefly
    // since the persist write is disk I/O following the IPC round-trip.
    await expect
      .poll(() => readFileSync(notePath, 'utf-8'), { timeout: 5000 })
      .toContain('[gid::')
    expect(readFileSync(notePath, 'utf-8')).toContain('ingestion lag')
  })

  test('right-click "Move to tomorrow" on the (now gid-persisted) task succeeds: no "task not found" error, task lands in tomorrow\'s Backlog', async () => {
    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'ingestion lag' })
    await expect(timelineTask).toBeVisible()
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')

    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to tomorrow' }).click()

    // No error banner should ever appear.
    const errorBanner = page.locator('[data-testid="move-task-error"]')
    await expect(errorBanner).not.toBeVisible({ timeout: 3000 })

    // The task disappears from today's Timeline...
    await expect(timelineTask).not.toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: join(artifactsDir, 'bug-move-task-not-found-gidless-task.png') })

    // ...and log evidence confirms a committed move, never a "not found".
    const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
    const logContent = readFileSync(logPath, 'utf-8')
    expect(logContent).not.toContain('daily-note move-task: task not found in source note')
    expect(logContent).toContain('daily-note move-task committed')

    // Source note no longer has the task; tomorrow's note was created with it
    // in the Backlog section.
    expect(readFileSync(notePath, 'utf-8')).not.toContain('ingestion lag')
    const tomorrowPath = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32', `${TOMORROW}.md`)
    const tomorrowContent = readFileSync(tomorrowPath, 'utf-8')
    expect(tomorrowContent).toContain('ingestion lag')
    expect(tomorrowContent).toContain('[gid::')
  })
})
