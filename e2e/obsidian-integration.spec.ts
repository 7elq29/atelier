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

test('current-time indicator is an absolutely-positioned overlay line on the hour grid (54a rewrite)', async () => {
  // Timeline is now an absolute-positioned hour grid (see the 54a rewrite):
  // the "now" marker is an absolutely-positioned overlay line at
  // `top: minutesToPx(minutes - TIMELINE_START_HOUR*60)`, not a row spliced
  // into a flat list. Outside the displayed window (06:00-22:00) it isn't
  // rendered at all, so this test is written to be correct regardless of the
  // real wall-clock time it happens to run at.
  const line = page.locator('[data-testid="current-time-line"]')
  const count = await line.count()
  if (count === 0) return

  await expect(line).toBeAttached()

  // Absolutely positioned: must carry an inline `top` style consistent with
  // minutesToPx(minutes - 360) at HOUR_HEIGHT_PX=60.
  const style = await line.evaluate((el) => (el as HTMLElement).getAttribute('style'))
  expect(style ?? '').toMatch(/top\s*:/)

  const minutesAttr = await line.getAttribute('data-minutes')
  const minutes = Number(minutesAttr)
  expect(minutes).toBeGreaterThanOrEqual(6 * 60)
  expect(minutes).toBeLessThanOrEqual(22 * 60)

  const top = await line.evaluate((el) => parseFloat((el as HTMLElement).style.top))
  const expectedTop = ((minutes - 6 * 60) / 60) * 60
  expect(top).toBeCloseTo(expectedTop, 0)

  // Pixel-position bracketing: every timeline-task block whose top is above
  // the marker's top must have a start time at or before "now", and every
  // one below must start after "now" (grid position, not DOM order, is what
  // determines "before/after" now).
  const blocks = page.locator('[data-testid="timeline-task"]')
  const blockCount = await blocks.count()
  for (let i = 0; i < blockCount; i++) {
    const block = blocks.nth(i)
    const blockTop = await block.evaluate((el) => parseFloat((el as HTMLElement).style.top))
    const start = await block.getAttribute('data-start')
    if (!start) continue
    const [h, m] = start.split(':').map(Number)
    const startMin = h * 60 + m
    if (blockTop <= top) {
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

  // Right-click near the bottom of the *actual* rendered timeline body,
  // well clear of the existing (short) cards near the top. Flat-list layout
  // sizes the body to its flex share of the panel, not to a fixed 24h-grid
  // pixel height, so unlike the old design we can't assume an arbitrary
  // large y-offset (e.g. 400px) is still inside the element — clamp to its
  // real bounding box instead.
  await timelineBody.click({ button: 'right', position: { x: 40, y: Math.max(20, box.height - 15) } })
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
// The absolute-grid "now" line (see Timeline.tsx, 54a rewrite) is positioned
// at `top: minutesToPx(minutes - TIMELINE_START_HOUR*60)`, independent of
// task rows. This exercises the case where "now" falls *inside* a task's own
// range (task already started, not yet finished): the marker's pixel top
// should land within that task block's [top, top+height) span. Seed a task
// whose time-block is computed at setup time to straddle the real "now"
// (±15 minutes), so this is verified against the actual wall clock rather
// than a fixed fictional time.
test.describe('current-time marker relative to an in-progress task', () => {
  const DATE = '2026-07-30'
  const GID_IN_PROGRESS = '55555555-5555-4555-8555-555555555555'
  const DAY_START_MIN = 6 * 60 // matches timeline-scale.ts TIMELINE_START_HOUR
  const DAY_END_MIN = 22 * 60 // matches timeline-scale.ts TIMELINE_END_HOUR

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
    test.skip(!inDisplayWindow, 'real wall-clock time is outside the displayed 06:00-22:00 window (with margin)')

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

  test('marker\'s pixel position lands within the span of a task whose range currently contains "now"', async () => {
    test.skip(!inDisplayWindow, 'real wall-clock time is outside the displayed 06:00-22:00 window (with margin)')

    const marker = inProgressPage.locator('[data-testid="current-time-line"]')
    await expect(marker).toBeAttached()

    const blocks = inProgressPage.locator('[data-testid="timeline-task"]')
    await expect(blocks).toHaveCount(1)
    await expect(blocks.nth(0)).toContainText('In-progress task spanning now')

    const markerTop = await marker.evaluate((el) => parseFloat((el as HTMLElement).style.top))
    const blockTop = await blocks.nth(0).evaluate((el) => parseFloat((el as HTMLElement).style.top))
    const blockHeight = await blocks.nth(0).evaluate((el) => parseFloat((el as HTMLElement).style.height))

    expect(markerTop).toBeGreaterThanOrEqual(blockTop)
    expect(markerTop).toBeLessThanOrEqual(blockTop + blockHeight)
  })
})

// ── 54a: absolute-grid Timeline rewrite (drag-move, resize, delete, overlap
// columns, pixel-Y create) ──────────────────────────────────────────────
//
// Own isolated Electron instance + fixture vault/date, following the same
// pattern as the "real-world content shapes" and "current-time marker"
// describes above, so these interaction tests don't depend on (or disturb)
// the ordering/mutations already baked into the main describe block above
// (e.g. the regression test's assumption that GID_STANDUP's time-block is
// still "09:00–09:15" after only being toggled, not moved).
test.describe('54a: absolute-grid interactions', () => {
  const DATE = '2026-07-29'
  const GID_MOVE = '66666666-6666-4666-8666-666666666666'
  const GID_RESIZE = '77777777-7777-4777-8777-777777777777'
  const GID_DELETE = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6'
  const GID_OVERLAP_A = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7'
  const GID_OVERLAP_B = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c8c8'

  let gridApp: ElectronApplication
  let gridPage: Page
  let gridVaultRoot: string
  let gridNotePath: string

  function seedGridFixtureContent(): string {
    return `---
date: ${DATE}
day: Wednesday
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:15 Standup [gid:: ${GID_MOVE}]
- [ ] 13:00–13:30 Resize target [gid:: ${GID_RESIZE}]
- [ ] 15:00–15:30 Delete target [gid:: ${GID_DELETE}]
- [ ] 10:00–11:00 Overlap A [gid:: ${GID_OVERLAP_A}]
- [ ] 10:00–11:00 Overlap B [gid:: ${GID_OVERLAP_B}]

### ⚪ Backlog
-

### 🤝 Delegated
-
`
  }

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-userdata-grid-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-vault-grid-'))
    gridVaultRoot = join(vaultParent, 'vault')
    // Path uses the ISO week number (see resolveNotePath in
    // daily-note-io.ts), not the day-of-month — 2026-07-29 falls in ISO
    // week 31, same as the other fixture dates in this file.
    const noteDir = join(gridVaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    gridNotePath = join(noteDir, `${DATE}.md`)
    writeFileSync(gridNotePath, seedGridFixtureContent(), 'utf-8')

    gridApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, GARDENIA_TEST_VAULT_ROOT: gridVaultRoot, GARDENIA_TEST_DATE: DATE }
    })
    gridPage = await gridApp.firstWindow()
    await gridPage.waitForLoadState('domcontentloaded')
    await expect(gridPage.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
    await expect(gridPage.locator('[data-testid="timeline-task"]')).toHaveCount(5)
  })

  test.afterAll(async () => {
    await gridApp.close()
  })

  test('renders the new grid Timeline with several tasks, including two overlapping ones, side-by-side', async () => {
    // Requirement 5: two overlapping 10:00-11:00 blocks (UC-10 overlap-column
    // layout) must render side-by-side (non-overlapping x-ranges), not
    // stacked on top of one another.
    const blockA = gridPage.locator('[data-testid="timeline-task"][data-task-id="' + GID_OVERLAP_A + '"]')
    const blockB = gridPage.locator('[data-testid="timeline-task"][data-task-id="' + GID_OVERLAP_B + '"]')
    const boxA = await blockA.boundingBox()
    const boxB = await blockB.boundingBox()
    if (!boxA || !boxB) throw new Error('overlap blocks not visible')

    // Same time range -> same vertical span.
    expect(boxA.y).toBeCloseTo(boxB.y, 0)
    expect(boxA.height).toBeCloseTo(boxB.height, 0)

    // Non-overlapping x-ranges: one block's right edge must be at/left of
    // the other's left edge (or vice versa) — i.e. rendered in separate
    // columns, not stacked at the same x position.
    const aRightAtOrBeforeBLeft = boxA.x + boxA.width <= boxB.x + 1
    const bRightAtOrBeforeALeft = boxB.x + boxB.width <= boxA.x + 1
    expect(aRightAtOrBeforeBLeft || bRightAtOrBeforeALeft).toBe(true)

    await gridPage.screenshot({ path: join(artifactsDir, '54a-timeline-grid.png') })
  })

  test('right-clicking at a specific pixel Y creates a task at the corresponding snapped time, not "now" (the actual #54 fix)', async () => {
    const timelineBody = gridPage.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    // y=50px from the top of the (unscrolled) grid is well clear of every
    // seeded block (the earliest, Standup, starts at 09:00 -> top=180px).
    // Per timeline-scale.ts: TIMELINE_START_HOUR=6 (360min), HOUR_HEIGHT_PX=60
    // (1px/min), SNAP_MINUTES=15 -> snapMinutes(360 + 50) = snapMinutes(410)
    // = 405min = 06:45. Default duration is 30min -> end = 07:15.
    await timelineBody.click({ button: 'right', position: { x: 40, y: 50 } })
    const input = gridPage.locator('[data-testid="timeline-new-task-input"]')
    await expect(input).toBeVisible()
    await input.fill('Pixel-Y right-click task')
    await input.press('Enter')

    await expect(gridPage.locator('[data-testid="timeline-task"]', { hasText: 'Pixel-Y right-click task' })).toBeVisible()
    await gridPage.waitForTimeout(1200)

    const content = readFileSync(gridNotePath, 'utf-8')
    appendSyncLog('54a: after pixel-Y right-click creation', content)
    const line = content.split('\n').find((l) => l.includes('Pixel-Y right-click task'))
    expect(line).toBeTruthy()
    expect(line).toMatch(/06:45[–-]07:15/)
  })

  test('drag-moving a scheduled block via real mouse events shifts its on-disk time-block, duration preserved', async () => {
    const block = gridPage.locator('[data-testid="timeline-task"][data-task-id="' + GID_MOVE + '"]')
    const box = await block.boundingBox()
    if (!box) throw new Error('move-target block not visible')

    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    const deltaY = 120 // 120px == 120 minutes at HOUR_HEIGHT_PX=60 (1px/min); 09:00+120min = 11:00

    await gridPage.mouse.move(startX, startY)
    await gridPage.mouse.down()
    await gridPage.mouse.move(startX, startY + deltaY, { steps: 10 })
    await gridPage.mouse.up()

    await gridPage.waitForTimeout(1200)
    const content = readFileSync(gridNotePath, 'utf-8')
    appendSyncLog('54a: after drag-move', content)
    const line = content.split('\n').find((l) => l.includes(GID_MOVE))
    expect(line, 'moved task line should still exist').toBeTruthy()
    // Original was 09:00-09:15 (15min duration); shifted by 120min -> 11:00-11:15.
    expect(line).toMatch(/11:00[–-]11:15/)
  })

  test('dragging a resize handle changes only the start OR only the end, not both', async () => {
    const bottomHandle = gridPage.locator('[data-testid="timeline-resize-bottom"][data-task-id="' + GID_RESIZE + '"]')
    const handleBox = await bottomHandle.boundingBox()
    if (!handleBox) throw new Error('resize handle not visible')

    const startX = handleBox.x + handleBox.width / 2
    const startY = handleBox.y + handleBox.height / 2
    const deltaY = 30 // extend the end by 30 minutes: 13:30 -> 14:00

    await gridPage.mouse.move(startX, startY)
    await gridPage.mouse.down()
    await gridPage.mouse.move(startX, startY + deltaY, { steps: 10 })
    await gridPage.mouse.up()

    await gridPage.waitForTimeout(1200)
    const content = readFileSync(gridNotePath, 'utf-8')
    appendSyncLog('54a: after resize (bottom handle)', content)
    const line = content.split('\n').find((l) => l.includes(GID_RESIZE))
    expect(line, 'resized task line should still exist').toBeTruthy()
    // Start (13:00) must be unchanged; only the end (13:30 -> 14:00) moves.
    expect(line).toMatch(/13:00[–-]14:00/)
  })

  test('clicking a block\'s delete button removes it from disk', async () => {
    const block = gridPage.locator('[data-testid="timeline-task"][data-task-id="' + GID_DELETE + '"]')
    await expect(block).toBeVisible()
    await block.hover()

    const deleteButton = gridPage.locator('[data-testid="timeline-task-delete"][data-task-id="' + GID_DELETE + '"]')
    await deleteButton.click()

    await expect(gridPage.locator('[data-testid="timeline-task"]', { hasText: 'Delete target' })).toHaveCount(0)

    await gridPage.waitForTimeout(1200)
    const content = readFileSync(gridNotePath, 'utf-8')
    appendSyncLog('54a: after delete', content)
    expect(content).not.toContain(GID_DELETE)
    expect(content).not.toContain('Delete target')
  })
})
