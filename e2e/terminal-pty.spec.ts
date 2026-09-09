/**
 * Standalone PTY/terminal e2e — not chained behind secondary-panels serial setup.
 * Maps to src/main/panels/pty.ts (see e2e/TEST_CATEGORIES.md secondary-panels).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.describe('terminal-pty', () => {
  test('terminal-only session: real shell echoes real output', async () => {
    test.setTimeout(60_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-pty-'))
    seedSkipOnboarding(userDataDir)
    const { app, page } = await launchApp(userDataDir)

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('project-path').fill(projectRoot)
      await page.getByTestId('mode-terminal').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

      await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 15_000 })
      const term = page.getByTestId('terminal-body')
      await term.click()

      const spawnErr = await page.evaluate(async () => {
        const id = 'e2e-terminal-pty-probe'
        try {
          await window.atelier.ptySpawn({ id, cwd: '/tmp', hostname: null, cols: 80, rows: 24 })
          await window.atelier.ptyKill(id)
          return null
        } catch (e) {
          return String(e)
        }
      })
      if (spawnErr) {
        const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
        writeFileSync(join(artifactsDir, 'terminal-pty-spawn-error.txt'), `${spawnErr}\nlog: ${logPath}\n`)
      }
      expect(spawnErr, 'ptySpawn IPC should succeed (see e2e-artifacts/terminal-pty-spawn-error.txt)').toBeNull()

      await page.keyboard.type('echo hello-from-terminal-mode')
      await page.keyboard.press('Enter')

      await expect.poll(async () => term.textContent(), { timeout: 15_000 }).toContain('hello-from-terminal-mode')
      await page.screenshot({ path: join(artifactsDir, 'terminal-pty-echo.png') })
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  /**
   * Regression: the wheel used to walk shell history instead of scrolling.
   * Terminals are tmux clients, which live in xterm's alternate buffer; with no
   * xterm scrollback there, xterm translates each wheel notch into ESC[A/ESC[B
   * and zsh recalls the previous command. tmux only treats the wheel as a
   * scroll when mouse reporting is on (Features/terminal-wheel-scroll/spec.md).
   */
  test('terminal: mouse wheel scrolls the pane scrollback instead of walking shell history', async () => {
    test.setTimeout(90_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-wheel-'))
    seedSkipOnboarding(userDataDir)
    const { app, page } = await launchApp(userDataDir)

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('project-path').fill(projectRoot)
      await page.getByTestId('mode-terminal').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

      await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 15_000 })
      const term = page.getByTestId('terminal-body')
      // Only the rendered viewport rows — term.textContent() would also pick up
      // the <style> block xterm injects into the container.
      const rows = term.locator('.xterm-rows')
      await term.click()

      // tmux repaints the pane on attach; typing before the prompt lands loses
      // the first characters of the command.
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toContain('%')
      await page.waitForTimeout(1_000)

      // Print a marker, then push it far off the top of the viewport.
      const marker = 'WHEEL-SCROLLBACK-MARKER'
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => rows.textContent(), { timeout: 15_000 }).toContain(marker)

      await page.keyboard.type('seq 1 150')
      await page.keyboard.press('Enter')
      // '149' only ever comes from the output — '150' is already on screen as
      // part of the echoed command line.
      await expect.poll(async () => rows.textContent(), { timeout: 15_000 }).toContain('149')
      // Only the viewport rows exist in the DOM, so the marker is genuinely
      // off-screen now — the only way back to it is real scrolling.
      expect(await rows.textContent()).not.toContain(marker)

      await term.hover()
      const wheel = async (deltaY: number, notches: number, until: (text: string) => boolean): Promise<string> => {
        let text = (await rows.textContent()) ?? ''
        for (let i = 0; i < notches && !until(text); i++) {
          await page.mouse.wheel(0, deltaY)
          await page.waitForTimeout(80)
          text = (await rows.textContent()) ?? ''
        }
        return text
      }

      const scrolledUp = await wheel(-120, 120, (text) => text.includes(marker))
      // Screenshotted unconditionally so the artifact also captures the broken
      // state (viewport pinned at the prompt) when this regresses.
      await page.screenshot({ path: join(artifactsDir, 'terminal-wheel-scrollback.png') })
      expect(scrolledUp, 'wheel-up should bring earlier output back into view').toContain(marker)

      // Scrolling back to the bottom leaves tmux copy-mode (`copy-mode -e`), so
      // the shell keeps taking input right after a scroll gesture. tmux paints
      // a "[position/total]" indicator for as long as copy-mode is active.
      const copyModeIndicator = /\[\d+\/\d+\]/
      const scrolledDown = await wheel(120, 200, (text) => !copyModeIndicator.test(text))
      expect(scrolledDown, 'scrolling back down should leave copy-mode').not.toMatch(copyModeIndicator)
      expect(scrolledDown).not.toContain(marker)

      await page.keyboard.type('echo post-scroll-ok')
      await page.keyboard.press('Enter')
      await expect.poll(async () => rows.textContent(), { timeout: 15_000 }).toContain('post-scroll-ok')

      const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
      expect(readFileSync(logPath, 'utf8')).toContain('tmux mouse reporting enabled')
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
