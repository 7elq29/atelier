import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction for "fix-new-session-path-history".
 *
 * Root cause (verified against current main):
 * `NewSessionModal.tsx`'s `useEffect` on `isOpen` (lines ~25-34)
 * unconditionally resets `projectPath` to `null` every time the modal opens,
 * for both the local-picker and the remote (`remote-project-path` free-text
 * input) flows. There is no persistence of previously-used paths, so a user
 * who types a remote path, cancels, and reopens the modal always sees a
 * blank field again.
 *
 * This spec documents the DESIRED behavior (remote path history/prefill is
 * available on reopen) so it FAILS now and will PASS once the fix lands —
 * "red now, green after fix", per CLAUDE.md's e2e philosophy.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-repro: new-session remote path is not remembered across modal reopen', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-path-history-'))
    seedSkipOnboarding(userDataDir)
    electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('remote project path typed in a previous open should be available again on reopen (currently it is wiped)', async () => {
    await openNewSessionModal(page)

    // Any remote host works to exercise the free-text remote-path field;
    // devpod-us-or is the one seeded by other specs' fixtures, but we don't
    // depend on an actual SSH connection here — the bug is purely about
    // client-side field state, so we never click "Start Session".
    const hostOptions = page.locator('[data-testid^="host-option-"]')
    await expect(hostOptions.first()).toBeVisible({ timeout: 10_000 })
    await hostOptions.first().click()

    const pathInput = page.getByTestId('remote-project-path')
    await expect(pathInput).toBeVisible()
    await pathInput.fill('/home/user/code/my-project')
    await expect(pathInput).toHaveValue('/home/user/code/my-project')

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-before-close.png') })

    // Cancel (not create) — matches the reported repro: type a path, then
    // close/cancel without starting a session.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    // Reopen.
    await openNewSessionModal(page)
    await hostOptions.first().click()
    const reopenedPathInput = page.getByTestId('remote-project-path')

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-after-reopen.png') })

    // DESIRED behavior: the previously-typed path should be offered again
    // (pre-filled, or at minimum retrievable from a history list) rather
    // than a blank field. Today NewSessionModal's isOpen effect always
    // resets projectPath to null, so this assertion fails.
    await expect(reopenedPathInput).toHaveValue('/home/user/code/my-project')
  })
})
