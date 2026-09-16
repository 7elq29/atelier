import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: join(__dirname, '..') })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.describe('Obsidian-backed app notes', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vault: string
  let notesFolder: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-obsidian-notes-'))
    vault = join(userDataDir, 'vault')
    notesFolder = join(vault, 'Atelier')
    mkdirSync(notesFolder, { recursive: true })
    writeFileSync(join(notesFolder, 'visible.md'), '---\ntags:\n  - atelier\n---\nVisible from Obsidian\n')
    writeFileSync(join(notesFolder, 'hidden.md'), 'Not tagged\n')
    seedE2eConfig(userDataDir, { vault: { root: vault, appNotesFolder: 'Atelier' } })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('lists only tagged notes, saves Markdown, renames, archives, and permanently deletes', async () => {
    await expect(page.getByTestId('app-note-row')).toHaveCount(1)
    await expect(page.getByTestId('app-note-row')).toContainText('visible')

    await page.getByTestId('new-app-note-button').click()
    const row = page.locator('[data-testid="app-note-row"]').filter({ hasText: 'Untitled note' })
    await expect(row).toBeVisible()
    const id = await row.getAttribute('data-note-id')
    const originalPath = join(notesFolder, 'Untitled note.md')
    await expect.poll(() => existsSync(originalPath)).toBe(true)
    await expect.poll(() => readFileSync(originalPath, 'utf-8')).toContain('  - atelier')

    await page.getByTestId('app-note-editor').click()
    await page.keyboard.type('Saved into Obsidian')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => readFileSync(originalPath, 'utf-8')).toContain('Saved into Obsidian')

    await row.getByTestId('app-note-menu-button').click()
    await page.getByTestId('app-note-menu-rename').click()
    await page.getByTestId('app-note-rename-input').fill('Renamed note')
    await page.keyboard.press('Enter')
    const renamedPath = join(notesFolder, 'Renamed note.md')
    await expect.poll(() => existsSync(renamedPath)).toBe(true)
    await expect.poll(() => existsSync(originalPath)).toBe(false)

    const renamedRow = page.locator('[data-testid="app-note-row"]').filter({ hasText: 'Renamed note' })
    await renamedRow.getByTestId('app-note-menu-button').click()
    await page.getByTestId('app-note-menu-delete').click()
    await expect(page.getByTestId('delete-app-note-dialog')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'obsidian-app-note-delete-confirmation.png') })
    await page.getByTestId('delete-app-note-cancel').click()
    await expect(renamedRow).toBeVisible()

    await renamedRow.getByTestId('app-note-menu-button').click()
    await page.getByTestId('app-note-menu-delete').click()
    await page.getByTestId('delete-app-note-archive').click()
    const archivedPath = join(notesFolder, 'archive', 'Renamed note.md')
    await expect.poll(() => existsSync(archivedPath)).toBe(true)
    expect(readFileSync(archivedPath, 'utf-8')).not.toContain('  - atelier')
    await expect(page.locator(`[data-note-id="${id}"]`)).toHaveCount(0)

    await page.getByTestId('new-app-note-button').click()
    const permanentRow = page.locator('[data-testid="app-note-row"]').filter({ hasText: 'Untitled note' })
    await expect(permanentRow).toBeVisible()
    await permanentRow.getByTestId('app-note-menu-button').click()
    await page.getByTestId('app-note-menu-delete').click()
    await page.getByTestId('delete-app-note-permanently').click()
    await expect.poll(() => existsSync(originalPath)).toBe(false)
  })
})
