import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction for "fix-remove-unexpected-version-corner".
 *
 * Root cause (verified against current main):
 * `src/renderer/src/App.tsx` lines ~480-482 permanently render a
 * `data-testid="debug-corner"` element ("VERSION {appVersion}") pinned to
 * the bottom-left of the empty-state main panel. Neither
 * `Features/UI-Design/mocks/index.html` nor
 * `Features/UI-Design/mocks/design-variants/variant-1-soft-paper.html`
 * contains anything resembling this element — it's not part of the approved
 * UI.
 *
 * IMPORTANT CONFLICT: `e2e/app-shell.spec.ts`'s test "IPC round-trip returns
 * a real app version" (lines ~36-47) explicitly asserts
 * `[data-testid="app-version"]` (nested inside `debug-corner`) DOES exist
 * and resolves to a real semver string, and depends on it being visible.
 * That spec exists to prove the app:getVersion IPC bridge actually works
 * end-to-end, not to bless the debug-corner's placement in the empty-state
 * UI. Whoever fixes this bug must decide: (a) keep an app-version element
 * for IPC-bridge testing but relocate/hide it from the normal empty-state
 * view (e.g. move it into Settings or a dev-only overlay), and update
 * app-shell.spec.ts accordingly, or (b) gate `debug-corner` behind a
 * dev/debug flag so it's absent in a normal run but the IPC path can still
 * be exercised another way. Either way, app-shell.spec.ts's "IPC round-trip"
 * test WILL need to change in lockstep with this fix — it is not silently
 * compatible with just deleting the element.
 *
 * This spec asserts the DESIRED behavior (no permanent version corner in a
 * normal running screenshot) and fails today.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

test.describe('bug-repro: permanent version corner not present in either mock', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-debug-corner-'))
    seedSkipOnboarding(userDataDir)
    electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('debug-corner (VERSION x.y.z) should not be visible in the normal empty-state view', async () => {
    await expect(page.getByTestId('main-empty-state')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, 'fix-remove-unexpected-version-corner.png') })

    // DESIRED: not present at all in a normal run (neither mock has it).
    // Today App.tsx renders it unconditionally, so this fails.
    await expect(page.getByTestId('debug-corner')).toHaveCount(0)
  })
})
