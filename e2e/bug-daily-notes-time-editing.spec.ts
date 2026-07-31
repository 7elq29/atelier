import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction / gap-documentation for "fix-daily-notes-time-editing-and-review".
 *
 * Root cause (verified against current main):
 * `Timeline.tsx`'s right-click "new task" draft (`handleContextMenu` ->
 * `setDraft({ timeBlock: defaultTimeBlock(), text: '' })`) only renders a
 * single `data-testid="timeline-new-task-input"` text field. `timeBlock` is
 * fixed at creation time via `defaultTimeBlock()` (anchored to "now",
 * rounded to the nearest 15-minute slot) and there is no UI control anywhere
 * in the draft form to change it before submitting.
 *
 * This is an ABSENCE bug, not a red/green one: there's nothing to assert
 * "should have failed" against today, since the feature simply doesn't
 * exist. So this spec documents the gap by asserting the draft form's
 * structure has ONLY the text input and no time-editing control — an
 * assertion that PASSES today, proving the gap is real and giving a
 * concrete regression guard once a time editor is added (the assertion
 * will need to be loosened/replaced then, not just deleted).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

test.describe('bug-repro: daily-notes timeline draft has no time-editing control', () => {
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

  test('right-click draft form exposes only a text input, no way to edit the time block', async () => {
    const timelineBody = page.locator('[data-testid="timeline-body"]')
    const box = await timelineBody.boundingBox()
    if (!box) throw new Error('timeline body not visible')

    await timelineBody.click({ button: 'right', position: { x: 40, y: Math.max(20, box.height / 2) } })

    const input = page.getByTestId('timeline-new-task-input')
    await expect(input).toBeVisible()

    // The draft's fixed time-block label is rendered as plain text
    // (.dn-tb-range), not an editable control.
    const draftRow = page.locator('.dn-time-block-draft')
    await expect(draftRow).toBeVisible()
    const rangeLabel = draftRow.locator('.dn-tb-range')
    await expect(rangeLabel).toBeVisible()
    await expect(rangeLabel.locator('input, select, button')).toHaveCount(0)

    // Documents the gap: the ONLY interactive form control in the entire
    // draft row is the text input. No time-picker input/select/button of
    // any kind exists alongside it.
    const allControls = await draftRow.locator('input, select, button').count()
    expect(allControls).toBe(1) // just timeline-new-task-input

    await page.screenshot({ path: join(artifactsDir, 'fix-daily-notes-time-editing-and-review.png') })

    // Clean up the draft so it doesn't leak into other assertions.
    await input.press('Escape')
  })
})
