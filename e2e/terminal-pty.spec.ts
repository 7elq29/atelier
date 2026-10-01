/**
 * Standalone PTY/terminal e2e — not chained behind secondary-panels serial setup.
 * Maps to src/main/panels/pty.ts (see e2e/TEST_CATEGORIES.md secondary-panels).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
      const rows = term.locator('.xterm-rows')
      await term.click()
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toContain('%')
      await page.waitForTimeout(500)

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

  /**
   * Regression: the bottom line used to be sliced in half. FitAddon takes the
   * row count from the parent's computed height (border-box here, so padding
   * included) while only subtracting padding declared on `.xterm`, so an inset
   * on `.term-body` bought a row that didn't fit and `overflow: hidden` cut it
   * (Features/terminal-pane-fit/spec.md).
   */
  test('terminal: the pane fits whole rows, never clipping the last line', async () => {
    test.setTimeout(90_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-fit-'))
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
      await expect.poll(async () => term.locator('.xterm-rows').textContent(), { timeout: 20_000 }).toContain('%')
      await page.waitForTimeout(1_000)

      const measurePaneFit = async (): Promise<{
        bottomSlack: number
        rightSlack: number
        paneHeight: number
        cellHeight: number
      }> =>
        page.evaluate(() => {
          const body = document.querySelector('.terminal-cache-entry.active .term-body') as HTMLElement
          const xterm = body.querySelector('.xterm') as HTMLElement
          const row = body.querySelector('.xterm-rows > div') as HTMLElement
          const style = getComputedStyle(body)
          const bodyBox = body.getBoundingClientRect()
          const xtermBox = xterm.getBoundingClientRect()
          return {
            // `.xterm`'s border box has to sit inside `.term-body`'s content box.
            bottomSlack: bodyBox.bottom - parseFloat(style.paddingBottom) - xtermBox.bottom,
            rightSlack: bodyBox.right - parseFloat(style.paddingRight) - xtermBox.right,
            paneHeight: bodyBox.height,
            cellHeight: parseFloat(getComputedStyle(row).height)
          }
        })

      // Heights are spread over one cell so at least one lands in the range that
      // used to overflow (paneHeight % cellHeight < the pane's vertical inset).
      for (const height of [800, 803, 806, 809, 812]) {
        await page.setViewportSize({ width: 1280, height })
        await page.waitForTimeout(700)
        const fit = await measurePaneFit()
        expect(fit.bottomSlack, `bottom of the terminal is clipped at window height ${height}: ${JSON.stringify(fit)}`).toBeGreaterThanOrEqual(0)
        expect(fit.rightSlack, `right edge of the terminal is clipped at window height ${height}: ${JSON.stringify(fit)}`).toBeGreaterThanOrEqual(0)
        // A whole row must never be wasted — that would mean the fit is too small.
        expect(fit.bottomSlack).toBeLessThan(fit.cellHeight + 4)
      }

      const box = await term.boundingBox()
      if (box) {
        await page.screenshot({
          path: join(artifactsDir, 'terminal-pane-fit-bottom.png'),
          clip: { x: box.x, y: box.y + box.height - 70, width: Math.min(box.width, 700), height: 70 }
        })
      }
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  /**
   * Dead-terminal recovery: when the shell exits, the keep-alive TerminalPanel
   * must respawn (create a new tmux session if the old one is gone) instead of
   * silently swallowing keystrokes.
   */
  test('terminal: auto-recovers after shell exit instead of staying dead', async () => {
    test.setTimeout(90_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-recover-'))
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
      const rows = term.locator('.xterm-rows')
      await term.click()
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toContain('%')
      await page.waitForTimeout(500)

      await page.keyboard.type('exit')
      await page.keyboard.press('Enter')

      // Overlay may flash briefly; wait until typing works again on a fresh shell.
      await expect
        .poll(async () => page.getByTestId('terminal-reconnect-overlay').count(), { timeout: 15_000 })
        .toBe(0)

      await term.click()
      await page.waitForTimeout(800)
      const marker = 'RECOVERED-SHELL-ALIVE'
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => rows.textContent(), { timeout: 15_000 }).toContain(marker)
      await page.screenshot({ path: join(artifactsDir, 'terminal-recover-after-exit.png') })
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  /**
   * Close must permanently kill the local atelier-* tmux session (not only detach).
   */
  test('terminal: closing a session kills its local tmux session', async () => {
    test.setTimeout(90_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-tmux-kill-'))
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

      const sessionId = await page
        .locator('[data-testid="session-row"][data-active="true"]')
        .getAttribute('data-session-id')
      expect(sessionId).toBeTruthy()
      const prefix = `atelier-${sessionId!.slice(0, 8)}`

      await expect
        .poll(
          () => {
            try {
              const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
              })
              return out.split('\n').some((n) => n.startsWith(prefix))
            } catch {
              return false
            }
          },
          { timeout: 15_000 }
        )
        .toBe(true)

      await page
        .locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
        .getByTestId('session-menu-button')
        .click()
      await page.getByTestId('menu-close').click()

      await expect
        .poll(
          () => {
            try {
              const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
              })
              return out.split('\n').some((n) => n.startsWith(prefix))
            } catch {
              return false
            }
          },
          { timeout: 15_000 }
        )
        .toBe(false)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  /**
   * Cortana Terminal only got openReady at create time; after relaunch the
   * keep-alive never remounted (Features/cortana-terminal-open-ready).
   */
  test('cortana: terminal works after create and after relaunch', async () => {
    test.setTimeout(120_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-term-'))
    seedSkipOnboarding(userDataDir)
    let app: ElectronApplication | undefined
    let page: Page

    const marker = 'CORTANA-TERM-ALIVE'
    try {
      ;({ app, page } = await launchApp(userDataDir))

      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('cortana-tag')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('tab-terminal').click()
      const term = page.getByTestId('terminal-body')
      const rows = term.locator('.xterm-rows')
      await expect(term).toBeVisible({ timeout: 15_000 })
      await term.click()
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => rows.textContent(), { timeout: 15_000 }).toContain(marker)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-create.png') })

      const sessionId = await page
        .locator('[data-testid="session-row"][data-active="true"]')
        .getAttribute('data-session-id')
      expect(sessionId).toBeTruthy()

      await app.close()
      app = undefined

      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('session-row')).toBeVisible({ timeout: 20_000 })
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('tab-terminal').click()
      const term2 = page.getByTestId('terminal-body')
      const rows2 = term2.locator('.xterm-rows')
      await expect(term2).toBeVisible({ timeout: 20_000 })
      await term2.click()
      await expect.poll(async () => rows2.textContent(), { timeout: 25_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      const marker2 = 'CORTANA-TERM-RELAUNCH'
      await page.keyboard.type(`echo ${marker2}`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => rows2.textContent(), { timeout: 15_000 }).toContain(marker2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-relaunch.png') })
    } finally {
      await app?.close().catch(() => undefined)
    }
  })
})
