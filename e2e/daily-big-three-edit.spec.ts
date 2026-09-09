import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const mainEntry = join(projectRoot, 'out', 'main', 'index.js')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

function dailyNoteMarkdown(): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 🗓️ Daily Big Three

* Existing first
* Existing second
* Existing third

## 📋 Tasks

- [ ] Preserve this task [gid:: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]

### ⚪ Backlog
-

### 🤝 Delegated
-

## 📝 Notes

Preserve this note body.
`
}

test('Daily Big Three can be edited, cancelled, saved, and reloaded', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-daily-big-three-profile-'))
  seedE2eConfig(userDataDir)
  const vaultRoot = join(mkdtempSync(join(tmpdir(), 'atelier-daily-big-three-vault-')), 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  const notePath = join(noteDir, `${TEST_DATE}.md`)
  writeFileSync(notePath, dailyNoteMarkdown(), 'utf8')
  mkdirSync(artifactsDir, { recursive: true })

  const launch = async () => {
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ATELIER_TEST_VAULT_ROOT: vaultRoot,
        ATELIER_TEST_DATE: TEST_DATE
      }
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('daily-notes-panel')).toBeVisible({ timeout: 10_000 })
    return { app, page }
  }

  let { app, page } = await launch()
  try {
    const focus = page.getByTestId('dn-big-three')
    await expect(focus.getByTestId('dn-big-three-item')).toHaveText([
      'Existing first',
      'Existing second',
      'Existing third'
    ])

    await focus.getByTestId('dn-big-three-edit').click()
    const inputs = focus.getByTestId('dn-big-three-input')
    await expect(inputs).toHaveCount(3)
    await inputs.nth(0).fill('Cancelled draft')
    await focus.getByTestId('dn-big-three-cancel').click()
    await expect(focus.getByTestId('dn-big-three-item').first()).toHaveText('Existing first')
    expect(readFileSync(notePath, 'utf8')).not.toContain('Cancelled draft')

    await focus.getByTestId('dn-big-three-edit').click()
    await inputs.nth(0).fill('Ship the Atelier update')
    await inputs.nth(1).fill('Prepare the interview plan')
    await inputs.nth(2).fill('Exercise before dinner')
    await page.screenshot({ path: join(artifactsDir, 'daily-big-three-edit.png') })
    await focus.getByTestId('dn-big-three-save').click()

    await expect(focus.getByTestId('dn-big-three-item')).toHaveText([
      'Ship the Atelier update',
      'Prepare the interview plan',
      'Exercise before dinner'
    ])
    await expect
      .poll(() => readFileSync(notePath, 'utf8'))
      .toContain('* Exercise before dinner')

    const saved = readFileSync(notePath, 'utf8')
    expect(saved).toContain('## 🗓️ Daily Big Three')
    expect(saved).toContain('* Ship the Atelier update')
    expect(saved).toContain('* Prepare the interview plan')
    expect(saved).toContain('- [ ] Preserve this task')
    expect(saved).toContain('Preserve this note body.')

    const logPath = join(userDataDir, 'logs', 'main.log')
    await expect.poll(() => existsSync(logPath)).toBe(true)
    await expect.poll(() => readFileSync(logPath, 'utf8')).toContain(
      '"msg":"daily-note write committed"'
    )

    await app.close()
    ;({ app, page } = await launch())
    await expect(page.getByTestId('dn-big-three-item')).toHaveText([
      'Ship the Atelier update',
      'Prepare the interview plan',
      'Exercise before dinner'
    ])
  } finally {
    await app.close().catch(() => undefined)
  }
})
