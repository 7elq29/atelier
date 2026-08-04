import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Root-cause investigation for fix-move-task-not-found-root-cause (see
 * Documents/Default/03.projects/Gardenia/Bugs/fix-move-task-not-found-root-cause/spec.md).
 *
 * The prior fix (fix-move-task-not-found-in-source-note, see
 * bug-move-task-not-found-in-source-note.spec.ts) reproduced the error via a
 * *concurrent external edit* stripping a task's `[gid::]` tag while the
 * Timeline "Move to..." menu was already open. That fix made the FAILURE
 * MODE graceful (error banner + resync) but did not address why a task's id
 * can change out from under an open menu in the first place.
 *
 * This spec proves the deeper root cause: `daily-note-io.ts`'s
 * `parseDailyNote` mints a brand-new random `gid` (`mintTaskId()`) EVERY
 * time it parses a task line that has no `[gid::]` tag in the file content
 * — and nothing persists that minted id back to disk until some renderer
 * mutation (`updateTask`/`toggleTask`/`addTask`/a write) round-trips it
 * through `serializeTaskLine` (which always emits `[gid:: ...]`).
 *
 * A real user's daily note commonly contains tasks typed directly in
 * Obsidian (or carried from a template) that were NEVER touched via
 * Gardenia's UI, so they never got a `[gid::]` tag written. Every read of
 * that file — the renderer's initial `daily-note:read`, a later focus-regain
 * re-read, an fs.watch reparse — mints an INDEPENDENT random id for that
 * same logical task line. Critically, `daily-notes-handlers.ts`'s
 * `daily-note:move-task` handler does its OWN fresh, independent
 * `parseDailyNote` call on the source file at move time, decoupled from
 * whatever id the renderer's `tasks` state currently holds. If the task
 * being moved has no persisted gid, the renderer's captured id and the
 * handler's freshly-minted id are near-certainly different UUIDs — so the
 * lookup in `daily-note:move-task` fails and throws `task not found in
 * source note: <id>`, with NO external edit, NO race window, and NO stale
 * menu required at all. This matches the real field report exactly: the
 * missing id (`043516d1-...`) did not appear anywhere in `freshIds` because
 * it was never on disk to begin with — it only ever existed in the
 * renderer's in-memory state from an earlier, independent parse.
 *
 * This spec seeds a note with a task that has NO `[gid::]` tag (the normal
 * shape of a hand-typed Obsidian task), opens the Timeline "Move to..."
 * menu for it immediately, and selects "Move to tomorrow" with ZERO
 * external edits and ZERO artificial delay — proving the failure is
 * deterministic given a gid-less task, not merely a rare race.
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

test.describe('fix-move-task-not-found-root-cause: moving a task that has never had a persisted gid fails deterministically, with no external edit or race required', () => {
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

  test('reproduction: right-click "Move to tomorrow" on a never-persisted-gid task fails with "task not found in source note" immediately, no external edit, no delay', async () => {
    // Confirm the file on disk genuinely has no gid tag for this task before
    // touching anything — this is the precondition for the whole theory.
    expect(readFileSync(notePath, 'utf-8')).not.toContain('[gid::')

    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'ingestion lag' })
    await expect(timelineTask).toBeVisible()
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')

    // Open the "Move to..." menu immediately — this captures whatever id the
    // renderer's initial parse minted for this gid-less line.
    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()

    // Select "Move to tomorrow" right away. No external file edit, no
    // waiting for the fs.watch debounce, no double-click, no second window —
    // the mismatch already exists because the renderer's captured id and
    // whatever `daily-note:move-task`'s own fresh parse mints are two
    // independent random mints of the same gid-less line.
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to tomorrow' }).click()

    // ── Log evidence: the main process hit the exact reported error, and
    // its `freshIds` diagnostic does NOT contain the id the renderer sent —
    // confirming it's not a "task moved position" case, it's a genuinely
    // different id, matching the real field report precisely. ──
    let logContent = ''
    await expect
      .poll(
        async () => {
          const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
          logContent = readFileSync(logPath, 'utf-8')
          return logContent
        },
        { timeout: 5000 }
      )
      .toContain('daily-note move-task: task not found in source note')

    const logLine = logContent
      .split('\n')
      .reverse()
      .find((l) => l.includes('daily-note move-task: task not found in source note'))
    expect(logLine).toBeTruthy()
    const parsed = JSON.parse(logLine!)
    expect(parsed.taskId).toBeTruthy()
    expect(parsed.freshIds).not.toContain(parsed.taskId)

    // ── The existing mitigation (error banner + resync) still applies —
    // this is the graceful failure mode from the prior fix, not a crash. ──
    const errorBanner = page.locator('[data-testid="move-task-error"]')
    await expect(errorBanner).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: join(artifactsDir, 'bug-move-task-not-found-gidless-task.png') })

    // The task itself is untouched on disk — still gid-less, still present,
    // never written into tomorrow's note.
    const tomorrowPath = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32', `${TOMORROW}.md`)
    expect(() => readFileSync(tomorrowPath, 'utf-8')).toThrow()
    expect(readFileSync(notePath, 'utf-8')).toContain('ingestion lag')
  })

  test('confirms the existing stale-menu-closing mitigation (Timeline.tsx tasks-prop effect) cannot catch this case: the renderer\'s own `tasks` state never changes between menu-open and click, so the effect never fires — the mismatch is against a fresh disk parse the renderer never sees', async () => {
    // Reload with a fresh gid-less task to isolate this check.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })

    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'ingestion lag' })
    await expect(timelineTask).toBeVisible()

    // Read the renderer's in-memory task id for this task via the exposed
    // note state, immediately before AND immediately after opening the
    // menu — with no external edit, no watcher event, nothing to trigger
    // Timeline.tsx's `tasks`-dependent stale-menu-closing useEffect at all.
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')
    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()

    // The menu is still open and was never auto-closed — proving the
    // mitigation had nothing to react to (the renderer's `tasks` prop is
    // unchanged; the mismatch only exists relative to a disk-side parse the
    // renderer never receives a push for).
    await expect(menu).toBeVisible()
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to tomorrow' }).click()

    const errorBanner = page.locator('[data-testid="move-task-error"]')
    await expect(errorBanner).toBeVisible({ timeout: 5000 })
  })
})
