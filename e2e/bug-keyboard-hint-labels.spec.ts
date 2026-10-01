/**
 * Repro for the ⌘-hint labelling regression.
 *
 * `generateHintLabels` falls off a cliff at 18 targets: past the 17-letter alphabet it switches
 * *every* label to a two-letter code starting at "ss". Because a badge only renders the next key
 * to press, the screen then fills with 17 identical letters, no target is reachable in one
 * keystroke, and the first target is activated by pressing the same letter twice.
 *
 * The allocator is checked directly across target counts (the app's own chrome tops out around a
 * dozen hintable controls, well under the cliff), and the live overlay is driven in the real app
 * to prove the badges it paints are still unique and prefix-free.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'
import {
  generateHintLabels,
  hintBadgeDisplayLabel
} from '../src/renderer/src/keyboard-hints/keyboard-hints'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-hint-labels-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/** What the user actually sees on a badge before typing anything. */
function initialBadges(labels: string[]): string[] {
  return labels.map((l) => hintBadgeDisplayLabel(l, ''))
}

test('hint labels stay unique, prefix-free, and mostly single-keystroke', () => {
  for (const count of [1, 5, 17, 18, 19, 30, 60, 120]) {
    const labels = generateHintLabels(count)
    const where = `count=${count}`

    expect(labels, where).toHaveLength(count)
    expect(new Set(labels).size, `${where}: labels must be unique`).toBe(count)

    // No label may be a strict prefix of another, or the longer one can never be typed.
    const prefixCollisions = labels.filter((a) => labels.some((b) => b !== a && b.startsWith(a)))
    expect(prefixCollisions, `${where}: prefix collisions`).toEqual([])

    // Every badge on screen must name a distinct next key, otherwise the user sees a wall of
    // identical letters and cannot tell which target a keystroke will hit.
    const badges = initialBadges(labels)
    const duplicateBadges = [...new Set(badges.filter((b, i) => badges.indexOf(b) !== i))]
    expect(duplicateBadges, `${where}: duplicate badge letters`).toEqual([])

    // Short labels must be handed out before long ones.
    const singles = labels.filter((l) => l.length === 1).length
    expect(singles, `${where}: expected some single-keystroke targets`).toBeGreaterThan(0)
    expect(
      labels.filter((l) => l.length > 2),
      `${where}: labels longer than two keys`
    ).toEqual([])
  }
})

/**
 * Repro: with ten or more numbered rows the digit labels stop being prefix-free
 * ("1" is a prefix of "10"), so ⌘+1 waits for a second digit forever — releasing
 * ⌘ throws the pending buffer away and only ⌘+11 ever jumps anywhere.
 */
test('⌘+1 jumps to the first numbered row even when a "1x" row exists', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-hint-digit-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)

  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1800, height: 1150 })
    })
    await expect(page.getByTestId('new-app-note-button')).toBeVisible({ timeout: 20_000 })

    // Daily note + Weekly plan + 10 app notes = 12 numbered rows, so labels reach "10".
    const noteRows = page.locator('[data-testid="app-note-row"]')
    while ((await noteRows.count()) < 10) {
      const before = await noteRows.count()
      await page.getByTestId('new-app-note-button').click({ timeout: 10_000 })
      await expect(noteRows).toHaveCount(before + 1)
    }
    // Only on-screen rows get numbered, so bring the top of the list back into view.
    await page.evaluate(() => {
      document.querySelector('.sidebar-lists-stack')?.scrollTo({ top: 0 })
    })

    await page.keyboard.down('Meta')
    await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 5_000 })

    const digitLabels = await page.$$eval('[data-keyboard-hint-label]', (els) =>
      els.map((el) => el.getAttribute('data-keyboard-hint-label') ?? '').filter((l) => /^[0-9]+$/.test(l))
    )
    expect(digitLabels, 'need a two-digit row for this repro').toContain('10')

    // Row "1" is the topmost numbered row; it must be reachable with one keystroke.
    const firstRowTestId = await page
      .locator('[data-keyboard-hint-label="1"]')
      .getAttribute('data-testid')
    expect(firstRowTestId).toBe('daily-note-row')

    await page.keyboard.press('1')
    await page.screenshot({ path: join(artifactsDir, 'bug-hint-digit-single-press.png') })
    await page.keyboard.up('Meta')

    await expect(page.getByTestId('daily-note-row')).toHaveAttribute('data-active', 'true')

    // Committing on release must not cost the two-digit rows their instant activation.
    await page.evaluate(() => {
      document.querySelector('.sidebar-lists-stack')?.scrollTo({ top: 0 })
    })
    await page.keyboard.down('Meta')
    await expect(page.getByTestId('keyboard-hints-overlay')).toBeVisible({ timeout: 5_000 })
    const twelfthNoteId = await page
      .locator('[data-keyboard-hint-label="12"]')
      .getAttribute('data-note-id')
    expect(twelfthNoteId).toBeTruthy()

    await page.keyboard.press('1')
    await page.keyboard.press('2')
    await expect(page.locator(`[data-note-id="${twelfthNoteId}"]`)).toHaveAttribute(
      'data-active',
      'true'
    )
    await page.keyboard.up('Meta')
  } finally {
    await app.close().catch(() => undefined)
  }
})
