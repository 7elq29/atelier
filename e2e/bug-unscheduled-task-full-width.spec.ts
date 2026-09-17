import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

test('unscheduled task label uses the full row width', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-unscheduled-width-'))
  seedE2eConfig(userDataDir)

  const vaultRoot = join(mkdtempSync(join(tmpdir(), 'atelier-e2e-unscheduled-width-vault-')), 'vault')
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
- [ ] What other caller doesn't pass mcp while processing the complete request [gid:: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]

### 🤝 Delegated
-

> [!invisible] Trackers
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

    const panel = page.getByTestId('daily-notes-panel')
    const row = page.getByTestId('unscheduled-task')
    const label = row.locator('.dn-task-chip-text')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(row).toBeVisible()

    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    await expect
      .poll(() => readFileSync(logPath, 'utf-8'), { timeout: 5_000 })
      .toContain('daily-note read')

    mkdirSync(artifactsDir, { recursive: true })
    await panel.screenshot({
      path: join(artifactsDir, 'bug-unscheduled-task-full-width.png')
    })

    const geometry = await row.evaluate((element) => {
      const rowRect = element.getBoundingClientRect()
      const labelRect = element.querySelector('.dn-task-chip-text')!.getBoundingClientRect()
      const actionsRect = element.querySelector('.dn-task-more')?.getBoundingClientRect()
      const body = element.closest('[data-testid="unscheduled-body"]') as HTMLElement
      return {
        rowWidth: rowRect.width,
        unusedRightWidth: rowRect.right - Math.max(labelRect.right, actionsRect?.right ?? labelRect.right),
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyScrollLeft: body.scrollLeft
      }
    })
    console.log('UNSCHEDULED WIDTH REPRODUCTION:', JSON.stringify(geometry))

    expect(geometry.rowWidth).toBeGreaterThan(200)
    expect(geometry.unusedRightWidth).toBeLessThanOrEqual(12)
    expect(geometry.bodyScrollWidth).toBe(geometry.bodyClientWidth)
    expect(geometry.bodyScrollLeft).toBe(0)
  } finally {
    await app.close()
  }
})
