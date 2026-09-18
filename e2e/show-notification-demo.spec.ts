import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
test.setTimeout(60_000)

test('Cmd held — l badge appears on composer', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-cmdl-badge-'))
  seedSkipOnboarding(userDataDir)
  mkdirSync(join(userDataDir, 'project'), { recursive: true })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await page.getByTestId('new-session-button').click()
  await page.getByTestId('project-path').fill(join(userDataDir, 'project'))
  await page.getByTestId('project-path').blur()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
  // Wait for session to fully connect — composer is only rendered after connection
  await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('composer-input').first()).toBeVisible()

  // Hold Cmd to trigger hint mode
  await page.keyboard.down('Meta')
  await page.waitForTimeout(300)

  await page.screenshot({ path: join(artifactsDir, 'cmdl-badge-on-composer.png') })

  // Press l — composer should get focus
  await page.keyboard.press('l')
  await page.keyboard.up('Meta')
  await page.waitForTimeout(200)

  const focused = await page.getByTestId('composer-input').first().evaluate(
    (el) => document.activeElement === el
  )
  console.log('Composer focused after Cmd+L:', focused)

  await page.screenshot({ path: join(artifactsDir, 'cmdl-after-l.png') })
  await app.close()
})
