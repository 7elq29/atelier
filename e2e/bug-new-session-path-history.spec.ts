import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fix verification for "fix-new-session-path-history" (bug #49).
 *
 * Root cause (verified against `main`): `NewSessionModal.tsx`'s `useEffect`
 * on `isOpen` unconditionally reset `projectPath` to `null` every time the
 * modal opened, for both the local-picker and the remote
 * (`remote-project-path` free-text input) flows, and there was no
 * persistence of previously-used paths anywhere.
 *
 * Fix: a `project_path_history(host_id, path, used_at)` SQLite table
 * (src/main/db.ts migration `0005_project_path_history`), populated by
 * `SessionStore.recordProjectPathUsage` whenever `SessionManager.createSession`
 * successfully creates a session (src/main/sessions/manager.ts), and read
 * back via `session:listRecentProjectPaths` -> `window.atelier.listRecentProjectPaths`
 * to populate a `<datalist>` on the remote path input
 * (`#remote-project-path-history`, `data-testid="remote-project-path-history"`).
 *
 * UX note / deviation from the original repro spec: the original repro typed
 * a path and then CANCELLED without creating a session, and asserted the
 * field would come back pre-filled on reopen. The chosen (and, per the task
 * brief, intentional) design instead records history only when a session is
 * actually created — recording on every keystroke of an abandoned, possibly
 * garbage path would pollute the history with paths nobody ever used — and
 * offers that history as opt-in `<datalist>` suggestions rather than
 * auto-filling the field, since auto-fill risks silently creating a session
 * in the wrong directory. This spec exercises that flow instead: create a
 * session against a path, reopen the modal, and confirm that path is now
 * offered as a selectable suggestion (not auto-filled) — including after a
 * simulated app relaunch, proving the history is read from SQLite rather
 * than kept only in React/in-memory state.
 *
 * Terminal mode is used for the real-session-creation steps: it exercises
 * the exact same `session:create` -> `SessionManager.createSession` path
 * (and thus the exact same history-recording call) as Claude Code mode,
 * without needing a real SSH round-trip to the devpod host — Terminal-mode
 * `createSession` never calls the harness (see manager.ts), so this stays
 * fast and network-independent while still being a real IPC round-trip
 * through the real SQLite DB, per this project's "no mocking" rule.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

/** Values of every <option> currently in the remote-path history datalist. */
async function historyOptionValues(page: Page): Promise<string[]> {
  return page.locator('[data-testid="remote-project-path-history"] option').evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value)
  )
}

test.describe('bug-repro: new-session remote path history', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-path-history-'))
    seedSkipOnboarding(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('creating a session records the path, which is then offered (not auto-filled) as history on reopen', async () => {
    await openNewSessionModal(page)

    const hostOptions = page.locator('[data-testid^="host-option-"]')
    await expect(hostOptions.first()).toBeVisible({ timeout: 10_000 })
    await hostOptions.first().click()

    // Terminal mode: no real SSH connection needed, but goes through the
    // exact same session:create -> createSession -> recordProjectPathUsage
    // path as Claude Code mode.
    await page.getByTestId('mode-terminal').click()

    const pathInput = page.getByTestId('remote-project-path')
    await expect(pathInput).toBeVisible()
    await pathInput.fill('/home/user/code/my-project')
    await expect(pathInput).toHaveValue('/home/user/code/my-project')

    // Before any session has ever been created for this host, there must be
    // no history yet offered.
    expect(await historyOptionValues(page)).toEqual([])

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-before-create.png') })

    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    // Reopen.
    await openNewSessionModal(page)
    await hostOptions.first().click()
    const reopenedPathInput = page.getByTestId('remote-project-path')

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-after-reopen.png') })

    // Not auto-filled: the field itself must still start blank on reopen
    // (avoids silently creating a session in the wrong directory).
    await expect(reopenedPathInput).toHaveValue('')

    // But the previously-used path is now offered as a selectable suggestion.
    await expect
      .poll(async () => historyOptionValues(page), { timeout: 5_000 })
      .toContain('/home/user/code/my-project')

    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('path history persists across an app relaunch (read from SQLite, not just in-memory state)', async () => {
    // Relaunch against the SAME userDataDir (same atelier.sqlite file) —
    // if history only lived in React state it would be gone here.
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    await openNewSessionModal(page)
    const hostOptions = page.locator('[data-testid^="host-option-"]')
    await expect(hostOptions.first()).toBeVisible({ timeout: 10_000 })
    await hostOptions.first().click()

    await expect
      .poll(async () => historyOptionValues(page), { timeout: 5_000 })
      .toContain('/home/user/code/my-project')

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-after-relaunch.png') })

    await page.getByRole('button', { name: 'Cancel' }).click()
  })
})
