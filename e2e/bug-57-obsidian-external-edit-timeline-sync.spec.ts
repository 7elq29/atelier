import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bug #57 repro: "When I move a todo from Tasks to Backlog in Obsidian, the
 * timeline doesn't reflect the change."
 *
 * The renderer/main watch pipeline (useDailyNote.ts's watchDailyNote/
 * onDailyNoteChanged, daily-notes-handlers.ts's fs.watch-based watcher) DOES
 * push a fresh reparse to the UI on every external file change — that part
 * is not broken. The actual bug is in the parser itself
 * (src/main/daily-note-io.ts, parseBulletLine): a task line's `section` is
 * computed as `timeBlock && sectionHint !== 'tracker' ? 'day-plan' : sectionHint`
 * — i.e. ANY line with a leading time-block-shaped prefix (e.g.
 * "09:30–10:00 ...") is force-classified as `day-plan` REGARDLESS of which
 * markdown heading it physically sits under. A real day-plan task moved as-is
 * (time-block prefix intact, exactly what a human drag/cut-paste in Obsidian
 * does) from "## Tasks" into "### Backlog" is therefore still parsed as
 * `section: 'day-plan'` and keeps rendering in the Timeline — the move is
 * silently ignored by the parser, even though the watcher correctly detected
 * the file change and pushed a fresh note.
 *
 * This test seeds a real vault fixture with one time-blocked Tasks entry,
 * confirms it renders in the Timeline, then performs a real external edit
 * (plain fs.writeFile + rename — simulating an Obsidian save, NOT an IPC
 * call) that cuts the task's line out of "## Tasks" and pastes it verbatim
 * (time-block prefix included) under "### Backlog". It asserts the Timeline
 * no longer shows the task and Unscheduled does, within a reasonable poll
 * window that comfortably covers the 300ms watcher debounce.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const GID_MOVED = 'ffaaffaa-ffaa-4faa-8faa-ffaaffaaffaa'
const GID_OTHER = 'aabbaabb-aabb-4abb-8abb-aabbaabbaabb'

function seedFixtureContent(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 09:30–10:00 Review design doc [gid:: ${GID_MOVED}]
- [ ] 11:00–11:30 Standup [gid:: ${GID_OTHER}]

### ⚪ Backlog
-

### 🤝 Delegated
-
`
}

function movedFixtureContent(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 11:00–11:30 Standup [gid:: ${GID_OTHER}]

### ⚪ Backlog
- [ ] 09:30–10:00 Review design doc [gid:: ${GID_MOVED}]

### 🤝 Delegated
-
`
}

test.describe('bug-57: external Obsidian edit moving a task from Tasks to Backlog propagates into the Timeline', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug57-userdata-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-bug57-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(notePath, seedFixtureContent(), 'utf-8')

    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('task starts in the Timeline, moves to Unscheduled after an external Obsidian-style edit', async () => {
    // Sanity: seeded state.
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Review design doc' })).toBeVisible()
    await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Review design doc' })).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '57-obsidian-timeline-sync-before.png') })

    // Real external edit: atomic write-temp-then-rename, exactly like
    // Obsidian's own save mechanism — NOT an IPC call into the app.
    const tmpPath = `${notePath}.tmp`
    writeFileSync(tmpPath, movedFixtureContent(), 'utf-8')
    renameSync(tmpPath, notePath)

    // Poll well past the 300ms watcher debounce.
    await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Review design doc' })).toBeVisible({
      timeout: 5_000
    })
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Review design doc' })).toHaveCount(0, {
      timeout: 5_000
    })
    // The unrelated Tasks entry must remain in the Timeline throughout.
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '57-obsidian-timeline-sync-after.png') })

    // Log evidence: the watcher did observe and reparse the external change.
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const logLines = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.includes('daily-note watcher'))
      .join('\n')
    expect(logLines).toContain('daily-note watcher: fs event')
    expect(logLines).toContain('daily-note watcher: reparsed after change')
  })
})
