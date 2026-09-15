/**
 * Assistant prose should read as a document, not a packed bubble: 15.5px at
 * 1.7 line-height, 16px paragraph gaps, quieter inline code. User input uses
 * a neutral subtle surface, and transcript margins scale with pane width.
 */
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, dims) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: dims.width, height: dims.height })
  }, { width, height })
}

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-chat-prose-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  return dir
}

test('chat prose, user input, and margins use a calm responsive rhythm', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-chat-prose-profile-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)
  const repoDir = fixtureRepo()

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('new-session-button')).toBeVisible({ timeout: 20_000 })

    const session = await page.evaluate(
      (projectPath) =>
        window.atelier.createSession({
          projectPath,
          mode: 'claude-code',
          hostId: 'local',
          suggestedName: 'Chat prose',
          initialPrompt: 'Reply with exactly READY and do not use tools.'
        }),
      repoDir
    )

    const row = page.locator(`[data-testid="session-row"][data-session-id="${session.id}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 90_000 })

    const composerInput = page.getByTestId('composer-input')
    await composerInput.fill(
      '**Update dashboard**\n\n' +
        '1. Match call and session conformity\n' +
        '2. Add pie chart\n' +
        '3. Add trend line'
    )
    const composerMarkdown = page.locator('.composer-markdown-input')
    await expect(composerMarkdown.locator('.cm-atomic-strong')).toContainText('Update dashboard')
    await expect(composerMarkdown.locator('.cm-atomic-list-marker').first()).toBeVisible()
    await composerInput.press('Control+Home')
    await page.waitForTimeout(100)
    await page.screenshot({ path: join(artifactsDir, 'ui-composer-inline-markdown.png') })
    await composerInput.fill('')
    await composerInput.click()
    await page.waitForTimeout(100)
    await page.screenshot({ path: join(artifactsDir, 'composer-cursor-position-after.png') })
    const composerCursorBounds = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement>('[data-testid="composer-input"]')
      const cursor = document.querySelector<HTMLElement>('.composer-cursor')
      if (!input || !cursor) return null
      const inputRect = input.getBoundingClientRect()
      const cursorRect = cursor.getBoundingClientRect()
      return {
        inputTop: inputRect.top,
        inputBottom: inputRect.bottom,
        inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
        paddingTop: Number.parseFloat(getComputedStyle(input).paddingTop),
        cursorTop: cursorRect.top,
        cursorBottom: cursorRect.bottom,
        cursorHeight: cursorRect.height
      }
    })
    expect(composerCursorBounds).not.toBeNull()
    expect(composerCursorBounds!.cursorTop).toBeGreaterThanOrEqual(composerCursorBounds!.inputTop)
    expect(composerCursorBounds!.cursorBottom).toBeLessThanOrEqual(composerCursorBounds!.inputBottom)
    expect(composerCursorBounds!.cursorHeight).toBeCloseTo(composerCursorBounds!.inputFontSize, 0)
    expect(
      Math.abs(
        composerCursorBounds!.cursorTop -
          (composerCursorBounds!.inputTop + composerCursorBounds!.paddingTop)
      )
    ).toBeLessThanOrEqual(6)

    await composerInput.fill(
      'Reply with exactly this Markdown and nothing else — no other words before or after it, ' +
        'do not use any tools: \n\n' +
        '**bold text**\n\n' +
        '`inline code`\n\n' +
        '```\ncode block line\n```\n\n' +
        '- item one\n- item two'
    )
    await expect(composerMarkdown.locator('.cm-atomic-strong')).toContainText('bold text')
    await expect(composerMarkdown.locator('.cm-atomic-list-marker').first()).toBeVisible()
    await page.getByTestId('send-button').click()

    const userMsg = page.locator('.msg-user[data-testid="transcript-message"]').last()
    await expect(userMsg.locator('.md-body strong')).toHaveText('bold text')
    await expect(userMsg.locator('.md-body ul li')).toHaveCount(2)
    await expect(userMsg).toHaveCSS('line-height', '26.35px')

    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })
    await expect(assistantMsg.locator('strong')).toHaveText('bold text', { timeout: 30_000 })
    await expect(assistantMsg.locator('code:not(pre code)')).toHaveText('inline code')
    await expect(assistantMsg.locator('ul li')).toHaveCount(2)

    const prose = await assistantMsg.evaluate((el) => {
      const cs = getComputedStyle(el)
      const paragraph = el.querySelector('p')
      const list = el.querySelector('ul')
      const nextItem = el.querySelector('li + li')
      const inlineCode = el.querySelector('code:not(pre code)')
      return {
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        paragraphMarginBottom: paragraph ? getComputedStyle(paragraph).marginBottom : '',
        listMarginBottom: list ? getComputedStyle(list).marginBottom : '',
        itemGap: nextItem ? getComputedStyle(nextItem).marginTop : '',
        inlineCodePadding: inlineCode ? getComputedStyle(inlineCode).padding : '',
        inlineCodeSize: inlineCode ? getComputedStyle(inlineCode).fontSize : ''
      }
    })
    expect(prose.fontSize).toBe('15.5px')
    expect(prose.lineHeight).toBe('26.35px')
    expect(prose.paragraphMarginBottom).toBe('16px')
    expect(prose.listMarginBottom).toBe('12px')
    expect(prose.itemGap).toBe('8px')
    expect(prose.inlineCodePadding).toBe('0px 3px')
    expect(prose.inlineCodeSize).toBe('13.95px')

    const userSurface = await page.locator('.msg-user').last().evaluate((el) => {
      const marker = document.createElement('span')
      document.body.appendChild(marker)
      marker.style.background = 'var(--bg-app)'
      const chatBackground = getComputedStyle(marker).backgroundColor
      marker.style.background = 'var(--bg-panel)'
      const panelBackground = getComputedStyle(marker).backgroundColor
      marker.style.background = 'var(--accent-dim)'
      const accentBackground = getComputedStyle(marker).backgroundColor
      marker.remove()
      const cs = getComputedStyle(el)
      return {
        background: cs.backgroundColor,
        chatBackground,
        panelBackground,
        accentBackground,
        alignSelf: cs.alignSelf,
        borderWidth: cs.borderWidth,
        radius: cs.borderRadius
      }
    })
    expect(userSurface.background).not.toBe(userSurface.chatBackground)
    expect(userSurface.background).not.toBe(userSurface.panelBackground)
    expect(userSurface.background).not.toBe(userSurface.accentBackground)
    expect(userSurface.alignSelf).toBe('flex-end')
    expect(userSurface.borderWidth).toBe('1px')
    expect(userSurface.radius).toBe('10px')

    await setWindowSize(app, 1400, 900)
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(artifactsDir, 'chat-assistant-width-after.png') })
    const mainLog = readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8')
    expect(mainLog).toContain('session:sendMessage invoked')
    expect(mainLog).toContain('harness event: result (turn complete)')
    const assistantWidths = await assistantMsg.evaluate((el) => ({
      message: el.getBoundingClientRect().width,
      wrapper: el.parentElement?.getBoundingClientRect().width ?? 0
    }))
    expect(assistantWidths.message).toBeCloseTo(assistantWidths.wrapper, 0)
    const widePadding = await page.locator('.transcript').evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingLeft)
    )
    await setWindowSize(app, 900, 700)
    await page.waitForTimeout(150)
    const narrowPadding = await page.locator('.transcript').evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingLeft)
    )
    expect(widePadding).toBeGreaterThan(narrowPadding)
    expect(widePadding).toBeLessThanOrEqual(64)
    expect(narrowPadding).toBeGreaterThanOrEqual(20)

    await setWindowSize(app, 1400, 900)
    await page.waitForTimeout(150)
    await page.locator('.msg-user').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactsDir, 'ui-chat-transcript-typography.png') })
  } finally {
    await app.close().catch(() => undefined)
  }
})
