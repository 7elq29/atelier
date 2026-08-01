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
// Extra seed content added for the 09-timeline.png screenshot artifact (see
// 09-obsidian-integration UI fix notes): a couple more time-blocks spread
// across the day (so the screenshot shows a flat, dense list rather than a
// near-empty panel) and a second tracker.
const GID_DEEP_WORK = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const GID_ONCALL_HANDOFF = '99999999-9999-4999-8999-999999999999'
const GID_READING_TRACKER = '88888888-8888-4888-8888-888888888888'

function seedFixtureContent(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:15 Standup [gid:: ${GID_STANDUP}]
- [ ] 11:00–11:30 1:1 with manager [gid:: ${GID_ONE_ON_ONE}]
- [ ] 17:45–18:30 Deep work: Terrablob failover doc [gid:: ${GID_DEEP_WORK}]
- [ ] 20:00–20:30 Prep for oncall handoff [gid:: ${GID_ONCALL_HANDOFF}]

### ⚪ Backlog
- [ ] Write PR description [gid:: ${GID_PR_DESC}]
- [ ] Reply to design review comments [gid:: ${GID_DESIGN_REVIEW}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker [gid:: ${GID_EXERCISE}]
> - [ ] Read 20 pages #tracker [gid:: ${GID_READING_TRACKER}]
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
  await expect(page.locator('[data-testid="timeline-task"]')).toHaveCount(4)
  await expect(page.locator('[data-testid="unscheduled-task"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="tracker-task"]')).toHaveCount(2)

  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })).toBeVisible()
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: '1:1 with manager' })).toBeVisible()
  await expect(
    page.locator('[data-testid="timeline-task"]', { hasText: 'Deep work: Terrablob failover doc' })
  ).toBeVisible()
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Prep for oncall handoff' })).toBeVisible()
  await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })).toBeVisible()
  await expect(
    page.locator('[data-testid="unscheduled-task"]', { hasText: 'Reply to design review comments' })
  ).toBeVisible()
  await expect(page.locator('[data-testid="tracker-task"]', { hasText: 'Exercise' })).toBeVisible()
  await expect(page.locator('[data-testid="tracker-task"]', { hasText: 'Read 20 pages' })).toBeVisible()

  await page.screenshot({ path: join(artifactsDir, '09-timeline.png') })
})

test('current-time indicator is a plain list row in chronological order (not an absolute overlay)', async () => {
  // Timeline is now a flat list (see 09-obsidian-integration UI fix): the
  // "now" marker is a plain row spliced between the tasks that bracket the
  // current time, not an absolutely-positioned overlay line on a 24h grid.
  // Outside the displayed window (06:00-23:00) it isn't rendered at all, so
  // this test is written to be correct regardless of the real wall-clock
  // time it happens to run at.
  const line = page.locator('[data-testid="current-time-line"]')
  const count = await line.count()
  if (count === 0) return

  await expect(line).toBeAttached()

  // Not absolutely positioned: no inline `top` style (that was the old,
  // now-fixed grid-overlay design).
  const style = await line.evaluate((el) => (el as HTMLElement).getAttribute('style'))
  expect(style ?? '').not.toMatch(/top\s*:/)

  const minutesAttr = await line.getAttribute('data-minutes')
  const minutes = Number(minutesAttr)
  expect(minutes).toBeGreaterThanOrEqual(0)
  expect(minutes).toBeLessThan(24 * 60)

  // Chronological bracketing: every timeline-task rendered *before* the
  // marker in DOM order must start at or before "now", and every one
  // rendered *after* must start after "now".
  const rows = page.locator('[data-testid="timeline-list"] > *')
  const rowCount = await rows.count()
  let seenMarker = false
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i)
    const testId = await row.getAttribute('data-testid')
    if (testId === 'current-time-line') {
      seenMarker = true
      continue
    }
    if (testId !== 'timeline-task') continue
    const start = await row.getAttribute('data-start')
    if (!start) continue
    const [h, m] = start.split(':').map(Number)
    const startMin = h * 60 + m
    if (!seenMarker) {
      expect(startMin).toBeLessThanOrEqual(minutes)
    } else {
      expect(startMin).toBeGreaterThan(minutes)
    }
  }
})

test('creating a task from a timeline right-click writes a [gid:: ...] field and round-trips', async () => {
  const timelineBody = page.locator('[data-testid="timeline-body"]')
  const box = await timelineBody.boundingBox()
  if (!box) throw new Error('timeline body not visible')

  // Right-click just below the last rendered row (time-block or "now"
  // marker), clamped inside the container — Timeline.tsx's context-menu
  // handler ignores right-clicks that land ON a `.dn-time-block` (see
  // `handleContextMenu`'s `.closest('.dn-time-block')` guard), so the click
  // must land in the gap *after* the last real row, not at a fixed offset
  // from the container's bottom edge. That fixed-offset approach broke when
  // 54b's header (progress bar/Big Three block) added height above the
  // Timeline section, shrinking the section's flex share enough that the
  // rows filled the container almost exactly, leaving no slack near the
  // bottom. Deriving the click position from the *content* (last row's own
  // bounding box) instead of the container's fixed height makes this robust
  // regardless of how much vertical space sibling header content takes.
  const rows = page.locator('[data-testid="timeline-list"] > *')
  const lastRowBox = await rows.last().boundingBox()
  const clickY = lastRowBox
    ? Math.min(lastRowBox.y + lastRowBox.height + 5 - box.y, box.height - 2)
    : Math.max(20, box.height - 15)
  await timelineBody.click({ button: 'right', position: { x: 40, y: clickY } })
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

test('dragging a task from the timeline back onto Unscheduled clears its time-block and updates the on-disk section', async () => {
  const block = page.locator('[data-testid="timeline-task"]', { hasText: 'Prep for oncall handoff' })
  const taskId = await block.getAttribute('data-task-id')
  expect(taskId).toBeTruthy()

  // Same synthetic DragEvent approach as the Unscheduled -> Timeline test
  // above, targeting the reverse drop zone (`unscheduled-body`). Both
  // directions read/write the same `text/task-id` dataTransfer key
  // (Timeline.tsx's task rows are `draggable` with `onDragStart` setting it;
  // DailyNotesSidebar's Unscheduled body has `onDrop` calling
  // `moveTask(id, 'unscheduled', undefined)`).
  await page.evaluate((id) => {
    const target = document.querySelector('[data-testid="unscheduled-body"]')
    if (!target) throw new Error('unscheduled body not found')
    const dt = new DataTransfer()
    dt.setData('text/task-id', id as string)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, taskId)

  await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Prep for oncall handoff' })).toBeVisible()
  await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Prep for oncall handoff' })).toHaveCount(0)

  await page.waitForTimeout(1200)
  const content = readFileSync(notePath, 'utf-8')
  appendSyncLog('after drag timeline -> unscheduled', content)

  // The task's gid line should now live under Backlog with no time-block
  // prefix.
  const lines = content.split('\n')
  const backlogHeaderIdx = lines.findIndex((l) => /^###\s+.*Backlog/i.test(l))
  const line = lines.find((l) => l.includes(GID_ONCALL_HANDOFF))
  expect(line).toBeTruthy()
  expect(line).toMatch(/^\s*-\s*\[.]\s*Prep for oncall handoff/)
  expect(line).not.toMatch(/\d{1,2}:\d{2}[–-]\d{1,2}:\d{2}/)
  expect(lines.indexOf(line!)).toBeGreaterThan(backlogHeaderIdx)
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

// ── Real-world content shapes (Unscheduled/Trackers rendering empty) ───────
//
// Added in response to a user report against their real vault: Unscheduled
// and Trackers appeared empty even though the underlying file had real
// content in these exact shapes. Kept as an ADDITIONAL, separately-launched
// suite (own Electron instance + own fixture vault/date) rather than folded
// into the fixture above, so both the original simple-fixture coverage and
// this real-world-shape coverage exist independently going forward. A
// separate launch is needed because the displayed date is fixed for the
// whole Electron session (via GARDENIA_TEST_DATE), so a second date's
// fixture needs a second session.
test.describe('real-world content shapes (multi-link tasks, no-link tasks, single tracker, emoji heading)', () => {
  const SHAPES_DATE = '2026-07-30'
  const GID_MULTI_LINK = '11111111-1111-4111-8111-111111111111'
  const GID_NO_LINK = '22222222-2222-4222-8222-222222222222'
  const GID_PLACEHOLDER_MULTI_LINK = '33333333-3333-4333-8333-333333333333'
  const GID_SINGLE_TRACKER = '44444444-4444-4444-8444-444444444444'

  let shapesApp: ElectronApplication
  let shapesPage: Page
  let shapesUserDataDir: string
  let shapesVaultRoot: string

  function seedShapesFixtureContent(): string {
    return `---
date: ${SHAPES_DATE}
day: Thursday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:15 Standup [gid:: aaaa0000-0000-4000-8000-000000000000]

### ⚪ Backlog
- [ ] Logging Failover Runbook ( / ) [SAW-7068](https://t3.uberinternal.com/browse/SAW-7068) [LOG-1167](https://linear.app/uber/issue/LOG-1167) [gid:: ${GID_PLACEHOLDER_MULTI_LINK}]
- [ ] Smooth logcollector -> Terrablob traffic [gid:: ${GID_NO_LINK}]
- [ ] Add high urgency alerts for increase in total number of tables experiencing ingestion lag per cluster ( / ) [SAW-7067](https://t3.uberinternal.com/browse/SAW-7067) [LOG-1166](https://linear.app/uber/issue/LOG-1166) [gid:: ${GID_MULTI_LINK}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker [gid:: ${GID_SINGLE_TRACKER}]
`
  }

  test.beforeAll(async () => {
    shapesUserDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-userdata-shapes-'))
    mkdirSync(join(shapesUserDataDir, 'data'), { recursive: true })
    writeFileSync(join(shapesUserDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-vault-shapes-'))
    shapesVaultRoot = join(vaultParent, 'vault')
    const noteDir = join(shapesVaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(join(noteDir, `${SHAPES_DATE}.md`), seedShapesFixtureContent(), 'utf-8')

    shapesApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${shapesUserDataDir}`],
      env: {
        ...process.env,
        GARDENIA_TEST_VAULT_ROOT: shapesVaultRoot,
        GARDENIA_TEST_DATE: SHAPES_DATE
      }
    })
    shapesPage = await shapesApp.firstWindow()
    await shapesPage.waitForLoadState('domcontentloaded')
    await expect(shapesPage.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await shapesApp.close()
  })

  test('Unscheduled renders all three real-world Backlog shapes (multi-link, no-link, placeholder text)', async () => {
    const unscheduled = shapesPage.locator('[data-testid="unscheduled-task"]')
    await expect(unscheduled).toHaveCount(3)

    // Multi-link task with a literal "( / )" placeholder in the text itself
    // (not something the parser should strip or choke on).
    await expect(
      unscheduled.filter({ hasText: 'Logging Failover Runbook ( / )' })
    ).toBeVisible()
    await expect(
      unscheduled.filter({
        hasText: 'Add high urgency alerts for increase in total number of tables experiencing ingestion lag per cluster ( / )'
      })
    ).toBeVisible()

    // Plain task with no bracketed links at all.
    await expect(unscheduled.filter({ hasText: 'Smooth logcollector -> Terrablob traffic' })).toBeVisible()
  })

  test('Trackers renders correctly with only a single tracker item', async () => {
    const trackers = shapesPage.locator('[data-testid="tracker-task"]')
    await expect(trackers).toHaveCount(1)
    await expect(trackers.filter({ hasText: 'Exercise' })).toBeVisible()
  })

  test('"### ⚪ Backlog" (emoji-prefixed heading) is recognized as the Unscheduled bucket', async () => {
    // If detectSection() only matched a literal "Backlog" without accounting
    // for the emoji prefix, none of the above would render at all — this is
    // a belt-and-suspenders check tying the visible count back to the exact
    // heading text used in real vaults.
    await expect(shapesPage.locator('[data-testid="unscheduled-task"]')).toHaveCount(3)
  })
})

// ── Current-time marker vs. an in-progress task ─────────────────────────
//
// The flat-list "now" marker (see Timeline.tsx) is spliced between the two
// tasks that bracket "now" by comparing `task.start > nowMinutes`. This only
// exercises the case where "now" falls strictly *between* two tasks; it
// doesn't exercise "now" falling *inside* a task's own range (task already
// started, not yet finished). Seed a task whose time-block is computed at
// setup time to straddle the real "now" (±15 minutes), so this is verified
// against the actual wall clock rather than a fixed fictional time.
test.describe('current-time marker relative to an in-progress task', () => {
  const DATE = '2026-07-30'
  const GID_IN_PROGRESS = '55555555-5555-4555-8555-555555555555'
  const DAY_START_MIN = 6 * 60 // matches timeline-scale.ts
  const DAY_END_MIN = 23 * 60

  let inProgressApp: ElectronApplication
  let inProgressPage: Page

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }
  function toHHMM(mins: number): string {
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`
  }

  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const inDisplayWindow = nowMinutes >= DAY_START_MIN + 15 && nowMinutes <= DAY_END_MIN - 15
  const rangeStart = toHHMM(nowMinutes - 15)
  const rangeEnd = toHHMM(nowMinutes + 15)

  test.beforeAll(async () => {
    test.skip(!inDisplayWindow, 'real wall-clock time is outside the displayed 06:00-23:00 window (with margin)')

    const userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-userdata-inprogress-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-vault-inprogress-'))
    const vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    const content = `---
date: ${DATE}
day: Thursday
type: daily
---

## 📋 Tasks

- [ ] ${rangeStart}–${rangeEnd} In-progress task spanning now [gid:: ${GID_IN_PROGRESS}]

### ⚪ Backlog
-

### 🤝 Delegated
-
`
    writeFileSync(join(noteDir, `${DATE}.md`), content, 'utf-8')

    inProgressApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, GARDENIA_TEST_VAULT_ROOT: vaultRoot, GARDENIA_TEST_DATE: DATE }
    })
    inProgressPage = await inProgressApp.firstWindow()
    await inProgressPage.waitForLoadState('domcontentloaded')
    await expect(inProgressPage.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    if (inProgressApp) await inProgressApp.close()
  })

  test('marker renders after (not before) a task whose range currently contains "now"', async () => {
    test.skip(!inDisplayWindow, 'real wall-clock time is outside the displayed 06:00-23:00 window (with margin)')

    const marker = inProgressPage.locator('[data-testid="current-time-line"]')
    await expect(marker).toBeAttached()

    const rows = inProgressPage.locator('[data-testid="timeline-list"] > *')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'timeline-task')
    await expect(rows.nth(0)).toContainText('In-progress task spanning now')
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'current-time-line')
  })
})

// ── List-management affordances (54b): add-task, inline edit, tags, Big
// Three/progress header, section collapse, close panel ──────────────────
//
// Own isolated Electron instance + own fixture vault/date, same pattern as
// "real-world content shapes" above, so these tests (which mutate on-disk
// state and eventually close the panel entirely) never interact with the
// main suite's shared page/fixture or its test ordering.
test.describe('list-management affordances (add-task, edit, tags, Big Three, collapse, close)', () => {
  const AFFORDANCES_DATE = '2026-07-29'
  const GID_STANDUP = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0'
  const GID_FOCUS_BLOCK = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0'
  const GID_EXISTING_BACKLOG = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'
  const GID_TAG_TARGET = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0'
  const GID_TRACKER = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0'

  let affApp: ElectronApplication
  let affPage: Page
  let affUserDataDir: string
  let affVaultRoot: string
  let affNotePath: string

  function seedAffordancesFixtureContent(): string {
    return `---
date: ${AFFORDANCES_DATE}
day: Wednesday
type: daily
---

## \u{1F5D3}\u{FE0F} Daily Big Three

* Ship the list-affordances PR
* Review teammate's diff
* Write weekly update

## 📋 Tasks

- [x] 09:00–09:30 Standup [gid:: ${GID_STANDUP}]
- [ ] 14:00–15:00 Focus block [gid:: ${GID_FOCUS_BLOCK}]

### ⚪ Backlog
- [ ] Existing backlog task [gid:: ${GID_EXISTING_BACKLOG}]
- [ ] Task to tag [gid:: ${GID_TAG_TARGET}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Water plants #tracker [gid:: ${GID_TRACKER}]
`
  }

  test.beforeAll(async () => {
    affUserDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-userdata-affordances-'))
    mkdirSync(join(affUserDataDir, 'data'), { recursive: true })
    writeFileSync(join(affUserDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-vault-affordances-'))
    affVaultRoot = join(vaultParent, 'vault')
    // Folder is the ISO WEEK number (`ww` in resolveNotePath), not the
    // day-of-month — Jul 29 2026 falls in ISO week 31, same as the other
    // fixtures' dates in this file.
    const noteDir = join(affVaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    affNotePath = join(noteDir, `${AFFORDANCES_DATE}.md`)
    writeFileSync(affNotePath, seedAffordancesFixtureContent(), 'utf-8')

    affApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${affUserDataDir}`],
      env: {
        ...process.env,
        GARDENIA_TEST_VAULT_ROOT: affVaultRoot,
        GARDENIA_TEST_DATE: AFFORDANCES_DATE
      }
    })
    affPage = await affApp.firstWindow()
    await affPage.waitForLoadState('domcontentloaded')
    await expect(affPage.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    if (affApp) await affApp.close()
  })

  test('add-task: "+ New task" under Unscheduled creates a task that round-trips to disk under Backlog', async () => {
    await affPage.locator('[data-testid="add-unscheduled-task"]').click()
    const input = affPage.locator('[data-testid="add-unscheduled-task-input"]')
    await expect(input).toBeVisible()
    await input.fill('Write the 54b report')
    await input.press('Enter')

    await expect(
      affPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Write the 54b report' })
    ).toBeVisible()

    await affPage.waitForTimeout(1200)
    const content = readFileSync(affNotePath, 'utf-8')
    const lines = content.split('\n')
    const backlogHeaderIdx = lines.findIndex((l) => /^###\s+.*Backlog/i.test(l))
    const delegatedHeaderIdx = lines.findIndex((l) => /^###\s+.*Delegated/i.test(l))
    const taskLineIdx = lines.findIndex((l) => l.includes('Write the 54b report'))
    expect(taskLineIdx).toBeGreaterThan(backlogHeaderIdx)
    expect(taskLineIdx).toBeLessThan(delegatedHeaderIdx)
    expect(lines[taskLineIdx]).toMatch(/^\s*-\s*\[.]\s*Write the 54b report/)
  })

  test('double-click edit: changing an existing task\'s text updates it on disk', async () => {
    const chip = affPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Existing backlog task' })
    await chip.locator('span').first().dblclick()

    const editInput = affPage.locator('[data-testid="task-edit-input"]')
    await expect(editInput).toBeVisible()
    await editInput.fill('Existing backlog task (edited)')
    await editInput.blur()

    await expect(
      affPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Existing backlog task (edited)' })
    ).toBeVisible()

    await affPage.waitForTimeout(1200)
    const content = readFileSync(affNotePath, 'utf-8')
    expect(content).toContain('Existing backlog task (edited)')
    expect(content).not.toMatch(/Existing backlog task(?! \(edited\))/)
  })

  test('tag UI: adding a tag round-trips to disk as #tagname, removing it clears it from disk', async () => {
    const chip = affPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Task to tag' })
    await chip.hover()
    await chip.locator('[data-testid="add-tag-button"]').click()

    const tagInput = chip.locator('[data-testid="tag-input"]')
    await expect(tagInput).toBeVisible()
    await tagInput.fill('ktlo')
    await tagInput.press('Enter')

    await expect(chip.locator('[data-testid="task-tag-chip"]', { hasText: '#ktlo' })).toBeVisible()

    await affPage.waitForTimeout(1200)
    let content = readFileSync(affNotePath, 'utf-8')
    const taggedLine = content.split('\n').find((l) => l.includes(GID_TAG_TARGET))
    expect(taggedLine).toContain('#ktlo')

    await chip.hover()
    await chip.locator('[data-testid="task-tag-chip"]', { hasText: '#ktlo' }).locator('[data-testid="task-tag-remove"]').click()
    await expect(chip.locator('[data-testid="task-tag-chip"]', { hasText: '#ktlo' })).toHaveCount(0)

    await affPage.waitForTimeout(1200)
    content = readFileSync(affNotePath, 'utf-8')
    const untaggedLine = content.split('\n').find((l) => l.includes(GID_TAG_TARGET))
    expect(untaggedLine).not.toContain('#ktlo')
  })

  test('Big Three + progress header: renders seeded focus items and the real done/total count', async () => {
    const focusItems = affPage.locator('[data-testid="dn-big-three-item"]')
    await expect(focusItems).toHaveCount(3)
    await expect(focusItems.nth(0)).toHaveText('Ship the list-affordances PR')
    await expect(focusItems.nth(1)).toHaveText("Review teammate's diff")
    await expect(focusItems.nth(2)).toHaveText('Write weekly update')

    // Real done/total count from the fixture: seeded actionable tasks are
    // Standup(done), Focus block(open), Existing backlog task(open),
    // Task to tag(open), Water plants tracker(open) = 1/5. The earlier
    // add-task test added one more open unscheduled task, so by this point
    // it's 1/6.
    await expect(affPage.locator('[data-testid="dn-progress"]')).toContainText('1/6 tasks done')
  })

  test('section collapse: clicking a chevron hides the section body and the sibling grows to reclaim space', async () => {
    const trackersSection = affPage.locator('[data-testid="trackers-section"]')
    const unscheduledSection = affPage.locator('[data-testid="unscheduled-section"]')
    const beforeBox = await unscheduledSection.boundingBox()
    if (!beforeBox) throw new Error('unscheduled section not visible')

    await affPage.locator('[data-testid="trackers-collapse-toggle"]').click()

    await expect(affPage.locator('[data-testid="trackers-body"]')).toHaveCount(0)
    await expect(trackersSection).toBeVisible()

    const afterBox = await unscheduledSection.boundingBox()
    if (!afterBox) throw new Error('unscheduled section not visible after collapse')
    expect(afterBox.height).toBeGreaterThan(beforeBox.height)

    await affPage.screenshot({ path: join(artifactsDir, '54b-collapsed-section.png') })

    // Re-expand for the header/progress screenshot below.
    await affPage.locator('[data-testid="trackers-collapse-toggle"]').click()
    await expect(affPage.locator('[data-testid="trackers-body"]')).toBeVisible()
  })

  test('header/progress/Big Three screenshot', async () => {
    await affPage.screenshot({ path: join(artifactsDir, '54b-list-affordances.png') })
  })

  test('close panel: clicking the close button hides the daily-notes panel', async () => {
    await affPage.locator('[data-testid="daily-notes-close"]').click()
    await expect(affPage.locator('[data-testid="daily-notes-panel"]')).toHaveCount(0)
  })
})
