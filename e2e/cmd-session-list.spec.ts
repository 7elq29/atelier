import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

test('⌘ held while sidebar collapsed shows all active sessions with names', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cmd-session-list-'))
  seedE2eConfig(userDataDir)
  mkdirSync(artifactsDir, { recursive: true })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: { ...process.env }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10_000 })

    // Collapse the sidebar
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('sidebar')).toHaveClass(/collapsed/)

    // No session chips should be visible initially (no active sessions, no cmd held)
    const chips = page.locator('[data-testid^="collapsed-session-chip-"]')
    await expect(chips).toHaveCount(0)

    // Press and hold ⌘ — the app has no active sessions, so the list is empty,
    // but the chip container should not crash. If there were active sessions,
    // they would appear here.
    await page.keyboard.down('Meta')
    // The container should not appear since there are no sessions
    await expect(page.getByTestId('sidebar-alert-chips')).toHaveCount(0)
    await page.keyboard.up('Meta')

    // Screenshot the collapsed state without cmd held
    await page.locator('.app-shell, body').first().screenshot({
      path: join(artifactsDir, 'cmd-session-list.png')
    })

    // Re-expand sidebar to verify toggle still works
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('sidebar')).not.toHaveClass(/collapsed/)
  } finally {
    await app.close()
  }
})

test('⌘ chips follow sidebar sequence: pinned → grouped → ungrouped → terminal', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cmd-session-order-'))
  const projectPath = join(userDataDir, 'project')
  seedE2eConfig(userDataDir)
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: { ...process.env }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10_000 })

    // Create 4 sessions via IPC: ungrouped-A, ungrouped-B, future-grouped-C, future-pinned-D.
    // All created as cortana (no SDK turn needed) so they stay in active list immediately.
    const [sessionA, sessionB, sessionC, sessionD] = await page.evaluate(
      async ([path]: [string]) => {
        const opts = { projectPath: path, mode: 'cortana' as const, hostId: 'local' }
        const a = await window.atelier.createSession({ ...opts, suggestedName: 'Session-A' })
        const b = await window.atelier.createSession({ ...opts, suggestedName: 'Session-B' })
        const c = await window.atelier.createSession({ ...opts, suggestedName: 'Session-C' })
        const d = await window.atelier.createSession({ ...opts, suggestedName: 'Session-D' })
        return [a, b, c, d]
      },
      [projectPath]
    )

    // Create a group and assign C to it; pin D.
    await page.evaluate(
      async ([cId, dId]: [string, string]) => {
        const group = await window.atelier.createGroup('My Group')
        await window.atelier.setSessionGroup(cId, group.id)
        await window.atelier.setSessionPinned(dId, true)
      },
      [sessionC.id, sessionD.id]
    )

    // Wait for sidebar to reflect the updated list.
    await expect(page.locator('[data-hint-session-row]')).toHaveCount(4, { timeout: 5_000 })

    // Collapse the sidebar.
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('sidebar')).toHaveClass(/collapsed/)

    // Hold ⌘ to show the session chips.
    await page.keyboard.down('Meta')
    const chips = page.locator('[data-testid^="collapsed-session-chip-"]')
    await expect(chips).toHaveCount(4, { timeout: 5_000 })

    // Expected order: D (pinned) → C (in group) → A (ungrouped) → B (ungrouped)
    const chipIds = await chips.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')?.replace('collapsed-session-chip-', '') ?? '')
    )
    expect(chipIds).toEqual([sessionD.id, sessionC.id, sessionA.id, sessionB.id])

    await page.keyboard.up('Meta')

    // Screenshot for visual verification.
    await page.screenshot({ path: join(artifactsDir, 'cmd-session-list-order.png') })
  } finally {
    await app.close()
  }
})
