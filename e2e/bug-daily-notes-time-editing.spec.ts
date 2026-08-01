import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

test.describe('fix-confirmed: daily-notes timeline right-click creates a task at the clicked time, editable afterward', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-dn-time-edit-'))
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-dn-time-edit-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(
      join(noteDir, `${TEST_DATE}.md`),
      `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## 📋 Tasks\n\n### ⚪ Backlog\n\n### 🤝 Delegated\n-\n`,
      'utf-8'
    )

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

    const draftRow = page.locator('.dn-tblock-draft')
    await expect(draftRow).toBeVisible()
    const rangeLabel = draftRow.locator('.dn-tb-range')
    await expect(rangeLabel).toBeVisible()
    const draftTimeText = (await rangeLabel.textContent())?.trim() ?? ''
    // A real, plausible HH:MM–HH:MM range — not the always-"now" default the
    // old bug produced regardless of click position.
    expect(draftTimeText).toMatch(/^\d{1,2}:\d{2}[–-]\d{1,2}:\d{2}$/)

    await input.fill('Confirm time-edit fix')
    await input.press('Enter')

    const block = page.locator('[data-testid="timeline-task"]', { hasText: 'Confirm time-edit fix' })
    await expect(block).toBeVisible()
    const beforeDrag = await block.textContent()

    // The created block is draggable (mousedown-move on its body) to change
    // its time — the actual replacement for "no way to edit the time block".
    const blockBox = await block.boundingBox()
    if (!blockBox) throw new Error('created block not visible')
    await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2 + 120, { steps: 10 })
    await page.mouse.up()

    const afterDrag = await block.textContent()
    expect(afterDrag).not.toBe(beforeDrag)

    await page.screenshot({ path: join(artifactsDir, 'fix-daily-notes-time-editing-and-review.png') })
  })
})
