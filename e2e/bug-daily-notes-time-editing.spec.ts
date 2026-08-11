import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fix confirmation for "fix-daily-notes-time-editing-and-review" (#54).
 *
 * Original root cause: `Timeline.tsx`'s right-click "new task" draft always
 * anchored its time block to `defaultTimeBlock()` ("now", rounded), with no
 * way to pick a different time before or after creating the task. This spec
 * used to document that gap (asserting the draft form had ONLY a text input,
 * no time control) as a regression guard, with a note that the assertion
 * would need to change once a real fix landed.
 *
 * The 54a Timeline grid rewrite fixed the actual root cause: right-click now
 * derives the draft's time block from the click's pixel Y position via
 * `yToMinutes` (see `e2e/obsidian-integration.spec.ts`'s "right-clicking at a
 * specific pixel Y creates a task at the corresponding snapped time" test for
 * that specific coverage), and once created, a task block can be dragged to
 * move it or resized via its top/bottom edge handles to change its time
 * range (also covered in `obsidian-integration.spec.ts`'s "54a: absolute-grid
 * interactions" suite). There is still no separate inline time-picker input
 * inside the draft popover itself — but there's no gap to document anymore,
 * since the click position IS the time picker, and the block is fully
 * editable after creation. This spec now confirms that end-to-end story
 * directly, using the renamed `.dn-tblock`/`.dn-tblock-draft` classes from
 * the grid rewrite (previously `.dn-time-block`/`.dn-time-block-draft`).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

test.describe('fix-confirmed: daily-notes timeline right-click creates a task at the clicked time, editable afterward', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-dn-time-edit-'))
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-dn-time-edit-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(
      join(noteDir, `${TEST_DATE}.md`),
      `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## 📋 Tasks\n\n### ⚪ Backlog\n\n### 🤝 Delegated\n-\n`,
      'utf-8'
    )
    notePath = join(noteDir, `${TEST_DATE}.md`)

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

  test('right-click draft is positioned at the clicked time, and the created block can be dragged to a new time afterward', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    // Click near the top of the grid (empty at this hour, well before any
    // seeded task) so the draft's derived time is deterministic-ish and
    // doesn't collide with anything.
    const clickY = Math.min(20, box.height - 2)
    await timelineBody.click({ button: 'right', position: { x: 40, y: clickY } })

    const input = page.getByTestId('timeline-new-task-input')
    await expect(input).toBeVisible()

    const draftBlock = page.getByTestId('timeline-draft-block')
    await expect(draftBlock).toBeVisible()
    const draftRange = page.getByTestId('timeline-draft-range')
    await expect(draftRange).toBeVisible()
    await expect(draftRange).toHaveCSS('font-size', '11px')
    await expect(draftRange).toHaveCSS('font-family', /mono/i)

    await input.fill('Confirm time-edit fix')
    await input.press('Enter')

    const block = page.locator('[data-testid="timeline-task"]', { hasText: 'Confirm time-edit fix' })
    await expect(block).toBeVisible()
    const beforeStart = await block.getAttribute('data-start')

    // The created block is draggable (mousedown-move on its body) to change
    // its time — the actual replacement for "no way to edit the time block".
    const blockBox = await block.boundingBox()
    if (!blockBox) throw new Error('created block not visible')
    await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2 + 120, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(async () => block.getAttribute('data-start'), { timeout: 5_000 })
      .not.toBe(beforeStart)

    await page.screenshot({ path: join(artifactsDir, 'fix-daily-notes-time-editing-and-review.png') })
  })

  test('empty timeline draft block dismisses when clicking empty grid space', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    const openY = Math.min(20, box.height - 2)
    await timelineBody.click({ button: 'right', position: { x: 40, y: openY } })
    await expect(page.getByTestId('timeline-draft-block')).toBeVisible()

    await timelineBody.click({ position: { x: 40, y: openY + 80 } })
    await expect(page.getByTestId('timeline-draft-block')).toHaveCount(0)
  })

  test('typing # in timeline draft shows #meeting among suggestions', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    await timelineBody.click({ button: 'right', position: { x: 40, y: Math.min(40, box.height - 2) } })
    const input = page.getByTestId('timeline-new-task-input')
    await expect(input).toBeVisible()
    await input.fill('#')
    await expect(page.getByTestId('inline-tag-suggestion').filter({ hasText: '#meeting' })).toBeVisible()
  })

  test('Tab autocompletes the first inline tag suggestion', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    await timelineBody.click({ button: 'right', position: { x: 40, y: Math.min(40, box.height - 2) } })
    const input = page.getByTestId('timeline-new-task-input')
    await expect(input).toBeVisible()
    await input.fill('Sync #meet')
    await expect(page.getByTestId('inline-tag-suggestions')).toBeVisible()
    await input.press('Tab')
    await expect(input).toHaveValue('Sync #meeting ')
  })

  test('editing a timeline task to add #meeting converts it to a note block without a checkbox', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    await timelineBody.click({ button: 'right', position: { x: 40, y: Math.min(100, box.height - 2) } })
    const input = page.getByTestId('timeline-new-task-input')
    await input.fill('Standup notes')
    await input.press('Enter')
    const block = page.locator('[data-testid="timeline-task"]', { hasText: 'Standup notes' })
    await expect(block).toBeVisible()
    await block.click({ button: 'right' })
    await page.getByTestId('task-rename-option').click()
    const editInput = page.getByTestId('timeline-task-edit-input')
    await editInput.fill('Standup notes #meeting')
    await editInput.press('Enter')
    await expect(block.locator('[data-testid="timeline-task-toggle"]')).toHaveCount(0)
    await page.waitForTimeout(1200)
    const content = readFileSync(notePath, 'utf-8')
    const line = content.split('\n').find((l) => l.includes('Standup notes') && l.includes('#meeting'))
    expect(line).toBeTruthy()
    expect(line).not.toMatch(/^-\s+\[/)
  })

  test('timeline task with #meeting serializes as a plain bullet without a checkbox', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    await timelineBody.click({ button: 'right', position: { x: 40, y: Math.min(60, box.height - 2) } })
    const input = page.getByTestId('timeline-new-task-input')
    await input.fill('Team sync #meeting')
    await input.press('Enter')

    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Team sync' })).toBeVisible()
    await page.waitForTimeout(1200)

    const content = readFileSync(notePath, 'utf-8')
    const line = content.split('\n').find((l) => l.includes('Team sync') && l.includes('#meeting'))
    expect(line).toBeTruthy()
    expect(line).toMatch(/^-\s+(?:\d{1,2}:\d{2}[^\s]+\s+)?Team sync #meeting/)
    expect(line).not.toMatch(/^-\s+\[/)
  })
})
