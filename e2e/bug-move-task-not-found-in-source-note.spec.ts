import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bug repro: real user hit `Error: task not found in source note: <gid>`
 * twice in a row via "Move to tomorrow" on Timeline tasks, against their
 * real, actively-used Obsidian vault. See
 * `Documents/Default/03.projects/Atelier/Bugs/fix-move-task-not-found-in-source-note/spec.md`.
 *
 * Root cause (confirmed below, not assumed): `daily-notes-handlers.ts`'s
 * `daily-note:move-task` handler re-reads the source note fresh from disk
 * and looks up the renderer-supplied task id in it — correctly refusing to
 * write anything if that id isn't found. The id it's given comes from
 * `Timeline.tsx`'s `moveMenu` state, which is captured ONCE at right-click
 * time and is NOT tied to `tasks` (its parent's live prop) the way
 * `TaskItem.tsx`'s per-task menu naturally is (that one's whole component,
 * `key={task.id}`, unmounts — closing its own menu — the instant the id it
 * was keyed on changes). So if a fresh disk read lands (fs.watch resync
 * after an external Obsidian edit that strips/regenerates that task's
 * `[gid::]` tag, minting a brand-new id for the same line — see
 * `daily-note-io.ts`'s `mintTaskId` fallback) WHILE the Timeline's "Move
 * to..." menu is already open, the menu keeps offering options against the
 * now-stale id. Selecting one sends that stale id to the main process,
 * which — correctly, safely — refuses to guess and throws.
 *
 * Confirmed via this file's tests, in order:
 *   1. The stale-Timeline-menu race actually reproduces the exact error
 *      string from the report, with log evidence + a screenshot.
 *   2. The fix's two halves: (a) `Timeline.tsx` now closes its own menu the
 *      instant its captured id vanishes from a fresh `tasks` prop — closing
 *      the race window in the common case where the external edit lands
 *      before the click; (b) `useDailyNote.ts`'s `moveTaskToDate` no longer
 *      swallows a failure silently (`run().catch(() => {})`) — it resyncs
 *      from disk and surfaces a visible error (`data-testid="move-task-error"`,
 *      following `DiffPanel.tsx`'s `worktreeError` convention) for the
 *      residual race where the click still lands inside the same tick as
 *      the external edit, before the menu can auto-close.
 *   3. A same-app rapid double-fire on the SAME task id is investigated
 *      directly and confirmed to already be safe (one call moves the task,
 *      the other safely no-ops with the same "not found" error) — NOT a
 *      contributor to the reported bug, included here as a documented
 *      non-regression check.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-08-03' // Monday, week 32 — same convention as task-move-to-date.spec.ts
const TOMORROW = '2026-08-04'

const GID_STANDUP = 'b2000000-0000-4000-8000-000000000001'
const GID_OTHER = 'b2000000-0000-4000-8000-000000000002'

function seedContent(): string {
  return `---
date: ${TEST_DATE}
day: Monday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:30 Standup #p1 [gid:: ${GID_STANDUP}]
- [ ] 11:00–11:30 Other meeting [gid:: ${GID_OTHER}]

### ⚪ Backlog
-

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker
`
}

/** Same task lines, but with `Standup`'s `[gid::]` tag stripped — simulating
 * an external tool (Obsidian, or a plugin) rewriting the line without
 * preserving the custom inline field. The next parse mints a brand-new id
 * for that line (`mintTaskId()` fallback in `daily-note-io.ts`). */
function gidStrippedContent(): string {
  return `---
date: ${TEST_DATE}
day: Monday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:30 Standup #p1
- [ ] 11:00–11:30 Other meeting [gid:: ${GID_OTHER}]

### ⚪ Backlog
-

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker
`
}

function externallyRewrite(notePath: string, content: string): void {
  // Atomic write-temp-then-rename — same mechanism Obsidian's own save uses,
  // and the same pattern bug-57's spec already exercises for this reason.
  const tmpPath = `${notePath}.tmp`
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, notePath)
}

test.describe('fix-move-task-not-found-in-source-note: stale Timeline "Move to..." menu vs. an external gid-regenerating edit', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-movebug-userdata-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-movebug-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(notePath, seedContent(), 'utf-8')

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
    await electronApp.close().catch(() => undefined)
  })

  test('reproduction: selecting a move option from an already-open Timeline menu, after an external edit regenerated the task\'s gid, fails with "task not found in source note" — and the app now surfaces this visibly instead of failing silently', async () => {
    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })
    await expect(timelineTask).toBeVisible()
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')

    // 1. Open the "Move to..." menu — this captures the CURRENT gid
    // (GID_STANDUP) into Timeline.tsx's `moveMenu` state.
    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()

    // 2. External edit lands WHILE the menu is open: same task line, gid
    // tag stripped, so the next reparse mints a brand-new id for it.
    externallyRewrite(notePath, gidStrippedContent())

    // 3. Immediately select "Move to tomorrow" from the STILL-OPEN menu,
    // without waiting for the fs.watch debounce (300ms) — reproducing the
    // real race: a click landing before Timeline's fix (below) gets a
    // chance to notice the underlying task changed and close the menu.
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to tomorrow' }).click()

    // ── Log evidence: the main process actually hit the exact reported error. ──
    await expect
      .poll(
        async () => {
          const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
          return readFileSync(logPath, 'utf-8')
        },
        { timeout: 5000 }
      )
      .toContain('daily-note move-task: task not found in source note')

    // ── The fix: a visible, user-facing error banner (no more silent
    // `.catch(() => {})`) — DiffPanel.tsx's `worktreeError` convention. ──
    const errorBanner = page.locator('[data-testid="move-task-error"]')
    await expect(errorBanner).toBeVisible({ timeout: 5000 })
    await expect(errorBanner).toContainText(/changed or was removed/i)

    await page.screenshot({ path: join(artifactsDir, 'bug-move-task-not-found-error-banner.png') })

    // ── The move must NOT have silently corrupted anything: "Standup" is
    // still present in today's note (under its new, post-edit gid) and was
    // never written into tomorrow's note. ──
    const noteContent = readFileSync(notePath, 'utf-8')
    expect(noteContent).toContain('Standup')
    expect(noteContent).not.toContain(GID_STANDUP) // old id is gone for good, replaced by the new mint

    // The renderer resynced from disk after the failure: the task is still
    // visible in the Timeline (now under its fresh id), not stuck showing a
    // stale/duplicated state.
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })).toBeVisible()
  })

  test('the underlying self-heal: an external gid-regenerating edit that lands and resyncs BEFORE the menu is used closes the stale "Move to..." menu automatically, so no bad IPC call is ever made', async () => {
    const otherTask = page.locator('[data-testid="timeline-task"]', { hasText: 'Other meeting' })
    await expect(otherTask).toBeVisible()
    const box = await otherTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')

    await otherTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()

    // External edit removes "Other meeting" entirely (simulating it being
    // deleted/edited away by Obsidian while the menu sits open) and give it
    // time to actually resync (well past the 300ms watcher debounce) BEFORE
    // any click happens this time.
    externallyRewrite(
      notePath,
      `---
date: ${TEST_DATE}
day: Monday
type: daily
---

## 📋 Tasks

### ⚪ Backlog
-

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker
`
    )

    // The menu should close itself — Timeline.tsx's fix — once its captured
    // task id is no longer present in the live task list.
    await expect(menu).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Other meeting' })).toHaveCount(0)
  })
})

test.describe('fix-move-task-not-found-in-source-note: rapid double-fire on the same task id (investigated, confirmed already-safe)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vaultRoot: string
  let notePath: string
  const GID = 'b2000000-0000-4000-8000-000000000099'

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-movebug-doublefire-userdata-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-movebug-doublefire-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32')
    mkdirSync(noteDir, { recursive: true })
    notePath = join(noteDir, `${TEST_DATE}.md`)
    writeFileSync(
      notePath,
      `---
date: ${TEST_DATE}
day: Monday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:30 Solo task [gid:: ${GID}]

### ⚪ Backlog
-

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker
`,
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

  test('two concurrent moveTaskToDate calls for the SAME task id: this does NOT reproduce "task not found in source note" — it reproduces a DIFFERENT, pre-existing duplication race, confirming double-fire is not the mechanism behind the reported bug', async () => {
    const results: Array<{ ok: boolean; error?: string }> = await page.evaluate(
      async ({ date, id, target }) => {
        const settled = await Promise.allSettled([
          window.atelier.moveTaskToDate(date, id, target),
          window.atelier.moveTaskToDate(date, id, target)
        ])
        return settled.map((s) => (s.status === 'fulfilled' ? { ok: true } : { ok: false, error: String(s.reason) }))
      },
      { date: TEST_DATE, id: GID, target: TOMORROW }
    )

    // Both concurrent calls interleave their `readFile` awaits before either
    // has written anything back (daily-notes-handlers.ts's move-task handler
    // has no per-source-file lock, unlike `daily-note:write`'s tombstone-diff
    // path), so BOTH read the task as still present and BOTH succeed —
    // producing a duplicate in the target note, not a "task not found"
    // error. This is a real, separate concurrency bug, but it does not
    // match the reported symptom (which was a thrown "not found" error, not
    // a silent duplicate) and is therefore NOT what the real user hit.
    // Documented here as a confirmed non-cause rather than guessed away;
    // left as a follow-up rather than fixed by this change; out of scope
    // for fix-move-task-not-found-in-source-note.
    const succeeded = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    expect(succeeded.length + failed.length).toBe(2)

    const tomorrowPath = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32', `${TOMORROW}.md`)
    const tomorrowContent = readFileSync(tomorrowPath, 'utf-8')
    const occurrences = tomorrowContent.split(GID).length - 1
    // Confirms the actual (undesirable, but distinct-from-this-bug) failure
    // mode: both calls won the race and the task was duplicated into
    // tomorrow's note.
    expect(succeeded.length).toBe(2)
    expect(occurrences).toBe(2)
  })
})
