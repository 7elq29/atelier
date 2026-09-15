/**
 * The file (Monaco) variant of the right-hand review pane used to frame a
 * `--bg-code` editor inside a `--bg-panel` shell: 8px of body padding above it
 * and a 28px comment gutter beside it, both panel-grey, read as a wide grey
 * border. Its title bar was also taller and heavier than every other panel
 * header in the app. This pins both down.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

/** The app's compact panel-header height, shared with the terminal header. */
const PANEL_HEADER_HEIGHT = 34
const LONG_LINE_MARKER = 'LONG_LINE_MUST_WRAP'

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-review-pane-chrome-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
  // No `.md` extension → review pane renders the Monaco (syntax-highlighted) variant.
  writeFileSync(
    join(dir, 'instructions.txt'),
    [
      `${LONG_LINE_MARKER}: ${'This sentence must stay inside the right review pane. '.repeat(12)}`,
      ...Array.from({ length: 23 }, (_, i) => `Line ${i + 2}: review pane chrome fixture content.`)
    ].join('\n')
  )
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  return dir
}

test('file review pane: editor is full-bleed and the title bar matches panel headers', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-review-pane-chrome-profile-'))
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
          suggestedName: 'Review pane chrome',
          initialPrompt: 'Reply with exactly READY and do not use tools.'
        }),
      repoDir
    )

    const row = page.locator(`[data-testid="session-row"][data-session-id="${session.id}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })

    await page.evaluate(
      ({ sessionId, target }) =>
        window.atelier.addSessionBookmark(sessionId, {
          kind: 'file',
          target,
          label: 'instructions.txt'
        }),
      { sessionId: session.id, target: join(repoDir, 'instructions.txt') }
    )

    const bookmarksButton = page.getByTestId('composer-bookmarks-button')
    await expect(bookmarksButton).toBeVisible({ timeout: 15_000 })
    await bookmarksButton.click()
    await page.getByTestId('chat-changes-bookmarks')
      .locator('[data-testid="chat-bookmark-row"][data-bookmark-kind="file"]')
      .click()

    const pane = page.getByTestId('response-review-pane')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    await expect(pane).toHaveAttribute('data-review-kind', 'file')
    await expect(page.getByTestId('response-review-file-monaco')).toBeVisible({ timeout: 20_000 })

    await page.screenshot({ path: join(artifactsDir, 'ui-review-pane-file-chrome.png') })
    await pane.screenshot({ path: join(artifactsDir, 'ui-review-pane-file-chrome-closeup.png') })
    await pane.screenshot({ path: join(artifactsDir, 'bug-review-pane-long-line-overflow.png') })

    const logPath = join(userDataDir, 'logs', 'main.log')
    await expect.poll(() => existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toContain('"msg":"bookmark:file opened in review panel"')

    // Bug repro: with Monaco's wordWrap disabled, the first source line is a
    // single very wide view line and the editor exposes horizontal overflow.
    const longLineLayout = await pane.getByTestId('response-review-file-monaco').evaluate(
      (editorRoot, marker) => {
        const host = editorRoot.closest('.response-review-file-monaco-host') as HTMLElement
        const line = [...editorRoot.querySelectorAll<HTMLElement>('.view-line')]
          .find((candidate) => candidate.textContent?.includes(marker))
        if (!line) throw new Error('Monaco long-line layout was not rendered')
        return {
          lineWidth: line.getBoundingClientRect().width,
          hostWidth: host.getBoundingClientRect().width
        }
      },
      LONG_LINE_MARKER
    )
    expect(longLineLayout.lineWidth).toBeLessThanOrEqual(longLineLayout.hostWidth)

    const head = pane.locator('.response-review-head')

    // Pixel proof that the frame is gone. The old chrome painted panel-grey in
    // an L around the editor: a band under the header (body padding) and a
    // column down the left (comment gutter). Sample one point in each; both
    // must now be the editor's own surface.
    const headHeight = await head.evaluate((el) => el.getBoundingClientRect().height)
    const framePixels = await page.evaluate(
      async ({ shot, top }) => {
        const binary = atob(shot)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const pane = document.querySelector('.response-review-pane') as HTMLElement
        const scale = bitmap.width / pane.clientWidth
        const at = (xCss: number, yCss: number): string => {
          const d = ctx.getImageData(Math.round(xCss * scale), Math.round(yCss * scale), 1, 1).data
          return `${d[0]},${d[1]},${d[2]}`
        }
        const editor = getComputedStyle(
          document.querySelector('.response-review-file-monaco-host')!
        )
          .backgroundColor.match(/\d+/g)!
          .slice(0, 3)
          .join(',')
        return {
          // Empty stretch of the title bar, between the title and the close button.
          header: at(pane.clientWidth * 0.6, top / 2),
          // Was the 8px body padding band.
          underHeader: at(pane.clientWidth / 2, top + 3),
          // Was the 28px panel-grey comment gutter.
          leftOfEditor: at(4, top + 40),
          editor
        }
      },
      { shot: (await pane.screenshot()).toString('base64'), top: headHeight }
    )
    expect(framePixels.underHeader).toBe(framePixels.editor)
    expect(framePixels.leftOfEditor).toBe(framePixels.editor)
    // Title bar shares the same surface, so the pane reads as one document.
    expect(framePixels.header).toBe(framePixels.editor)

    // ...and the style behind it: the pane itself owns the document background,
    // leaving the body and gutter nothing of their own to paint.
    const surfaces = await page.evaluate(() => {
      const body = document.querySelector('.response-review-body') as HTMLElement
      return {
        editor: getComputedStyle(
          document.querySelector('.response-review-file-monaco-host')!
        ).backgroundColor,
        pane: getComputedStyle(document.querySelector('.response-review-pane')!).backgroundColor,
        bodyPaddingTop: getComputedStyle(body).paddingTop
      }
    })
    expect(surfaces.pane).toBe(surfaces.editor)
    expect(surfaces.bodyPaddingTop).toBe('0px')

    // Title bar matches the compact panel-header language.
    const headBox = await head.boundingBox()
    expect(headBox).toBeTruthy()
    expect(headBox!.height).toBeLessThanOrEqual(PANEL_HEADER_HEIGHT)

    const headStyle = await head.evaluate((el) => {
      const title = el.querySelector('[data-testid="response-review-title"]')!
      return {
        borderBottomWidth: getComputedStyle(el).borderBottomWidth,
        titleSize: getComputedStyle(title).fontSize
      }
    })
    expect(headStyle.titleSize).toBe('13px')
    // Only a hairline separates header from content now that they share a surface.
    expect(headStyle.borderBottomWidth).toBe('1px')

    await expect(pane).not.toContainText('select text to comment')
    await expect(pane.locator('.response-review-sub')).toHaveCount(0)

    const close = page.getByTestId('response-review-close')
    const closeBox = await close.boundingBox()
    const paneBox = await pane.boundingBox()
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(paneBox!.x + paneBox!.width)
  } finally {
    await app.close().catch(() => undefined)
  }
})
