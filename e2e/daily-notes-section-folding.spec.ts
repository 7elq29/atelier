import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

test('Unscheduled and Trackers fold independently', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-daily-folding-'))
  seedE2eConfig(userDataDir)

  const vaultRoot = join(mkdtempSync(join(tmpdir(), 'atelier-e2e-daily-folding-vault-')), 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  writeFileSync(
    join(noteDir, `${TEST_DATE}.md`),
    `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog
- [ ] Prepare launch notes [gid:: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Read 20 pages #tracker [gid:: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb]
`,
    'utf-8'
  )

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const unscheduledToggle = page.getByTestId('unscheduled-section-toggle')
    const trackersToggle = page.getByTestId('trackers-section-toggle')
    const unscheduledBody = page.getByTestId('unscheduled-body')
    const trackersBody = page.getByTestId('trackers-body')
    await expect(page.getByTestId('daily-notes-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('unscheduled-task')).toHaveCount(1)
    await expect(page.getByTestId('tracker-task')).toHaveCount(1)

    await unscheduledToggle.click()
    await expect(unscheduledToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(unscheduledBody).toHaveCount(0)
    await expect(trackersBody).toBeVisible()

    await trackersToggle.click()
    await expect(trackersToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(trackersBody).toHaveCount(0)

    mkdirSync(artifactsDir, { recursive: true })
    await page.getByTestId('daily-notes-panel').screenshot({
      path: join(artifactsDir, 'daily-notes-sections-folded.png')
    })

    await unscheduledToggle.click()
    await expect(unscheduledToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('unscheduled-task')).toHaveText(/Prepare launch notes/)
    await expect(trackersBody).toHaveCount(0)

    await trackersToggle.click()
    await expect(trackersToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('tracker-task')).toHaveText(/Read 20 pages/)
  } finally {
    await app.close()
  }
})
