import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  appendFileSync,
  cpSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const syncLogPath = join(artifactsDir, '09-vault-sync.log')

// Fixed test date so the fixture path (`01.dailynotes/2026/Jul/31/...`) is
// deterministic regardless of when this suite runs.
const TEST_DATE = '2026-07-31'

const GID_STANDUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GID_ONE_ON_ONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GID_PR_DESC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GID_DESIGN_REVIEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const GID_EXERCISE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function seedFixtureContent(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:15 Standup [gid:: ${GID_STANDUP}]
- [ ] 11:00–11:30 1:1 with manager [gid:: ${GID_ONE_ON_ONE}]

### ⚪ Backlog
- [ ] Write PR description [gid:: ${GID_PR_DESC}]
- [ ] Reply to design review comments [gid:: ${GID_DESIGN_REVIEW}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker [gid:: ${GID_EXERCISE}]
`
}

function appendSyncLog(label: string, content: string): void {
  mkdirSync(artifactsDir, { recursive: true })
  appendFileSync(syncLogPath, `\n\n===== ${label} =====\n${content}\n`)
}

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let vaultRoot: string
let notePath: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-userdata-'))
  // Pre-seed onboarding as completed (08-global-nav-and-settings) so its
  // modal backdrop doesn't intercept clicks meant for the Daily Notes panel.
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

  const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-vault-'))
  vaultRoot = join(vaultParent, 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  notePath = join(noteDir, `${TEST_DATE}.md`)
  writeFileSync(notePath, seedFixtureContent(), 'utf-8')

  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(syncLogPath, `09-vault-sync.log — obsidian-integration e2e run\nvaultRoot=${vaultRoot}\nnotePath=${notePath}\n`)

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      GARDENIA_TEST_VAULT_ROOT: vaultRoot,
      GARDENIA_TEST_DATE: TEST_DATE
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
})


test.afterAll(async () => {
  // Copy the main-process structured log (which carries every watcher/write/
  // tombstone-diff decision logged via logger.info in daily-notes-handlers.ts)
  // into the sync log artifact.
  try {
    const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
    const lines = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.includes('daily-note'))
      .join('\n')
    appendSyncLog('main-process daily-note log lines', lines)
  } catch {
    // best-effort
  }
  await electronApp.close()

  // Retain the fixture vault directory itself as an artifact (per
  // e2e-test-plan.md), so the exact on-disk state at the end of the run is
  // inspectable without re-running the suite.
  try {
    const vaultArtifactDir = join(artifactsDir, '09-vault-fixture')
    rmSync(vaultArtifactDir, { recursive: true, force: true })
    cpSync(vaultRoot, vaultArtifactDir, { recursive: true })
  } catch {
    // best-effort
  }
})

test('seeded tasks render correctly in Timeline/Unscheduled/Trackers', async () => {
  await expect(page.locator('[data-testid="timeline-task"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="unscheduled-task"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="tracker-task"]')).toHaveCount(1)

  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })).toBeVisible()
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: '1:1 with manager' })).toBeVisible()
  await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })).toBeVisible()
  await expect(
    page.locator('[data-testid="unscheduled-task"]', { hasText: 'Reply to design review comments' })
  ).toBeVisible()
  await expect(page.locator('[data-testid="tracker-task"]', { hasText: 'Exercise' })).toBeVisible()

  await page.screenshot({ path: join(artifactsDir, '09-timeline.png') })
})

test('current-time indicator renders at a plausible vertical position', async () => {
  const line = page.locator('[data-testid="current-time-line"]')
  await expect(line).toBeAttached()
  const minutesAttr = await line.getAttribute('data-minutes')
  const minutes = Number(minutesAttr)
  expect(minutes).toBeGreaterThanOrEqual(0)
  expect(minutes).toBeLessThan(24 * 60)

  const top = await line.evaluate((el) => (el as HTMLElement).style.top)
  const topPx = parseFloat(top)
  // DAY_START_MIN=360 (06:00), PX_PER_MIN=2 (see timeline-scale.ts)
  const expectedTop = (minutes - 360) * 2
  expect(Math.abs(topPx - expectedTop)).toBeLessThan(1)
})

test('creating a task from a timeline right-click writes a [gid:: ...] field and round-trips', async () => {
  const timelineBody = page.locator('[data-testid="timeline-body"]')
  const box = await timelineBody.boundingBox()
  if (!box) throw new Error('timeline body not visible')

  // Right-click somewhere in the middle of the timeline (well after existing
  // blocks) to open the inline creation form.
  await timelineBody.click({ button: 'right', position: { x: 40, y: 400 } })
  const input = page.locator('[data-testid="timeline-new-task-input"]')
  await expect(input).toBeVisible()
  await input.fill('Deep work: token refresh fix')
  await input.press('Enter')

  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Deep work: token refresh fix' })).toBeVisible()

  // Wait past the 500ms write debounce + margin for the write to land on disk.
  await page.waitForTimeout(1200)

  const content = readFileSync(notePath, 'utf-8')
  appendSyncLog('after task creation', content)
  const gidMatch = content.match(/Deep work: token refresh fix.*\[gid:: ([0-9a-f-]+)]/)
  expect(gidMatch, 'new task line should carry a [gid:: <uuid>] field').toBeTruthy()
  expect(gidMatch![1]).toMatch(/^[0-9a-f-]{36}$/)

  // Round-trip: every gid seeded originally is still present, plus the new one.
  for (const gid of [GID_STANDUP, GID_ONE_ON_ONE, GID_PR_DESC, GID_DESIGN_REVIEW, GID_EXERCISE]) {
    expect(content).toContain(gid)
  }
})

test('dragging a task from Unscheduled onto the timeline updates the on-disk time-block', async () => {
  const chip = page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })
  const taskId = await chip.getAttribute('data-task-id')
  expect(taskId).toBeTruthy()

  // Native HTML5 DnD doesn't fire real drag events under Playwright's
  // synthetic mouse driver reliably, so dispatch the drag/drop sequence
  // directly on the timeline-body DOM node (rather than via
  // elementFromPoint(x, y), which is fragile against layout/viewport
  // clipping — a point outside the actual rendered content resolves to
  // <body>, and an event dispatched there never bubbles down into our React
  // tree). Uses the same dataTransfer key (`text/task-id`) Timeline.tsx /
  // TaskItem.tsx read from.
  await page.evaluate((id) => {
    const target = document.querySelector('[data-testid="timeline-body"]')
    if (!target) throw new Error('timeline body not found')
    const dt = new DataTransfer()
    dt.setData('text/task-id', id as string)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, taskId)

  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Write PR description' })).toBeVisible()
  await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })).toHaveCount(0)

  await page.waitForTimeout(1200)
  const content = readFileSync(notePath, 'utf-8')
  appendSyncLog('after drag unscheduled -> timeline', content)

  // The task's gid line should now carry a time block and live under Tasks,
  // not under Backlog.
  const line = content.split('\n').find((l) => l.includes(GID_PR_DESC))
  expect(line).toBeTruthy()
  expect(line).toMatch(/^\s*-\s*\[.]\s*\d{1,2}:\d{2}[–-]\d{1,2}:\d{2}\s+Write PR description/)
})

test('resizing sections keeps independent scroll and persists weights', async () => {
  const handle = page.locator('.dn-resize-handle').first()
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('resize handle not visible')

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200, { steps: 15 })
  await page.mouse.up()

  // Weight object is the source of truth (drives flex-grow); pixel height is
  // also checked but with tolerance since flex rounding/min-height can blur
  // an exact px delta.
  const storedWeights = await page.evaluate(() => localStorage.getItem('gardenia.dailyNotes.sectionWeights'))
  expect(storedWeights).toBeTruthy()
  const weights = JSON.parse(storedWeights!)
  expect(weights.timeline).toBeGreaterThan(2) // grew from the default weight of 2
  expect(weights.unscheduled).toBeLessThan(1) // unscheduled gave up the corresponding weight

  // Each section body scrolls independently: scrolling one must not move another.
  const unscheduledBody = page.locator('[data-testid="unscheduled-body"]')
  await unscheduledBody.evaluate((el) => (el.scrollTop = 5))
  const trackersScrollTop = await page
    .locator('[data-testid="trackers-body"]')
    .evaluate((el) => el.scrollTop)
  expect(trackersScrollTop).toBe(0)
})

test('regression: external delete racing an in-flight write does not resurrect the deleted task', async () => {
  // Sanity: the target task is present before we start.
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: '1:1 with manager' })).toBeVisible()
  await page.screenshot({ path: join(artifactsDir, '09-delete-no-resurrect-before.png') })

  // Arm the test-only hook: the *next* write-daily-note call will sleep
  // 1500ms after capturing its incoming payload, but before doing its
  // fresh-disk-read + tombstone diff. This simulates a write already
  // "in flight" (payload captured, not yet persisted) at the moment an
  // external edit lands.
  await page.evaluate(() => window.gardenia.testDelayNextWrite(1500))

  // Trigger a local mutation to an UNRELATED task (toggle Standup done) —
  // this schedules a debounced write (500ms) whose captured payload still
  // includes the "1:1 with manager" task, since the renderer hasn't heard
  // about the upcoming external delete yet.
  await page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' }).click()

  // ~700ms after the click (so: after the 500ms write debounce fires and the
  // write handler has entered its artificial 1500ms delay, but well before
  // that delay elapses), delete "1:1 with manager" directly in the fixture
  // file — an atomic write-temp+rename, exactly like Obsidian's own save.
  await page.waitForTimeout(700)
  const beforeDelete = readFileSync(notePath, 'utf-8')
  appendSyncLog('fixture content before external delete', beforeDelete)
  expect(beforeDelete).toContain(GID_ONE_ON_ONE)

  const withoutOneOnOne = beforeDelete
    .split('\n')
    .filter((l) => !l.includes(GID_ONE_ON_ONE))
    .join('\n')
  const tmpPath = `${notePath}.tmp`
  writeFileSync(tmpPath, withoutOneOnOne, 'utf-8')
  renameSync(tmpPath, notePath)
  appendSyncLog('external delete performed', `removed line containing gid ${GID_ONE_ON_ONE}`)

  // Wait out: remaining ~800ms of the artificial write delay, the write
  // itself, then the 300ms watcher debounce, plus margin.
  await page.waitForTimeout(3000)

  await page.screenshot({ path: join(artifactsDir, '09-delete-no-resurrect-after.png') })

  // 1. The deleted task must not reappear in the UI.
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: '1:1 with manager' })).toHaveCount(0)

  // 2. Nor in the file on disk.
  const finalContent = readFileSync(notePath, 'utf-8')
  appendSyncLog('fixture content after full round-trip', finalContent)
  expect(finalContent).not.toContain(GID_ONE_ON_ONE)
  expect(finalContent).not.toContain('1:1 with manager')

  // 3. The unrelated local mutation (Standup toggled done) DID persist —
  // proving the write generally succeeded and wasn't just short-circuited.
  expect(finalContent).toMatch(/- \[x] 09:00–09:15 Standup/)

  // 4. Prove there really was a race, not a trivial no-conflict case: the
  // main-process log must show the write's *captured* incoming payload
  // still contained the doomed task's id, and the tombstone diff is what
  // dropped it.
  const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
  const logLines = readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const delayedEntry = logLines.find((e) => e.msg === 'daily-note write delayed (test hook)')
  const tombstoneEntry = logLines.find((e) => e.msg === 'daily-note tombstone diff: dropping externally-deleted tasks')
  expect(delayedEntry, 'expected a delayed-write log entry').toBeTruthy()
  expect(delayedEntry.incomingIds).toContain(GID_ONE_ON_ONE)
  expect(tombstoneEntry, 'expected a tombstone-diff log entry').toBeTruthy()
  expect(tombstoneEntry.tombstoned).toContain(GID_ONE_ON_ONE)
  expect(tombstoneEntry.freshIds).not.toContain(GID_ONE_ON_ONE)

  appendSyncLog(
    'tombstone-diff decision (regression test)',
    JSON.stringify({ delayedEntry, tombstoneEntry }, null, 2)
  )
})
