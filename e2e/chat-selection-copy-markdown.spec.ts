import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

test('selecting rendered assistant content copies its original Markdown source', async ({}, testInfo) => {
  testInfo.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-copy-markdown-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-copy-markdown-project-'))
  writeFileSync(join(projectDir, 'README.md'), '# clipboard test\n')
  seedE2eConfig(userDataDir)
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  try {
    const markdown = [
      '## Copy heading',
      '',
      'A **bold phrase** with [Example](https://example.com).',
      '',
      '- first',
      '- second'
    ].join('\n')

    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page
      .getByTestId('initial-prompt')
      .fill(`Do not use tools. Reply with exactly this Markdown and nothing else:\n\n${markdown}`)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const assistantMessage = page.locator('.msg-assistant[data-testid="transcript-message"]:visible').first()
    await expect(assistantMessage.getByRole('heading', { name: 'Copy heading' })).toBeVisible({
      timeout: 60_000
    })
    const markdownBody = assistantMessage.locator('.md-body')
    await markdownBody.evaluate((element) => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''))
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')

    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe(markdown)

    const bold = assistantMessage.locator('strong')
    await bold.evaluate((element) => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe('**bold phrase**')

    const heading = assistantMessage.getByRole('heading', { name: 'Copy heading' })
    await heading.evaluate((element) => {
      const text = element.querySelector('[data-md-source-text]')?.firstChild
      if (!text) throw new Error('source-positioned heading text not found')
      const selection = window.getSelection()
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 4)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe('Copy')
  } finally {
    await electronApp.close()
  }
})
