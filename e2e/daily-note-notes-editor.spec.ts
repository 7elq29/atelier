import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { deflateSync } from 'node:zlib'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const UNIQUE_LINE = 'Gardenia daily notes slice e2e marker'
const EXTERNAL_NOTES_LINE = 'Edited from Obsidian in ## Notes'

function buildSolidRedPng(width: number, height: number): Buffer {
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, 'ascii')
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(data.length, 0)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3
      raw[px] = 255
      raw[px + 1] = 0
      raw[px + 2] = 0
    }
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

async function clickAtomicEditorLinkIcon(page: Page, editor: ReturnType<Page['getByTestId']>): Promise<void> {
  const link = editor.locator('.cm-atomic-link').first()
  await expect(link).toBeVisible({ timeout: 10_000 })
  const handle = await link.elementHandle()
  if (!handle) throw new Error('atomic editor link missing')
  await page.evaluate((el) => {
    const rects = Array.from(el.getClientRects())
    const lastRect = rects[rects.length - 1]
    if (!lastRect) throw new Error('atomic editor link rect missing')
    const emSize = parseFloat(window.getComputedStyle(el).fontSize)
    const iconZone = emSize * 1.25
    const x = lastRect.right - iconZone / 2
    const y = lastRect.top + lastRect.height / 2
    const target = document.elementFromPoint(x, y)
    if (!(target instanceof Element)) throw new Error('atomic editor link icon target missing')
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
  }, handle)
}

async function dispatchEditorPaste(page: Page, pngBytes: Buffer, fileName: string): Promise<void> {
  const editor = page.getByTestId('daily-note-editor')
  await editor.click()
  const handle = await editor.locator('.cm-content').elementHandle()
  if (!handle) throw new Error('daily note CodeMirror content missing')
  await page.evaluate(
    ({ el, bytes, fileName }) => {
      const file = new File([new Uint8Array(bytes)], fileName, { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: dt })
      el.dispatchEvent(event)
    },
    { el: handle, bytes: Array.from(pngBytes), fileName }
  )
}

function fixtureWithNotesBody(notesBody: string): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog

### 🤝 Delegated
-

> [!invisible] Trackers

## 📝 Notes

${notesBody}
`
}

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let notePath: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  const vaultRoot = join(vaultParent, 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  notePath = join(noteDir, `${TEST_DATE}.md`)
  writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

  mkdirSync(artifactsDir, { recursive: true })

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ATELIER_TEST_VAULT_ROOT: vaultRoot,
      ATELIER_TEST_DATE: TEST_DATE
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

test.describe('Daily note Notes slice editor (sidebar main panel)', () => {
  test('opens from sidebar, edits ## Notes body, persists to vault file', async () => {
    await page.getByTestId('daily-note-row').click()
    const title = page.getByTestId('main-title')
    const header = page.getByTestId('daily-note-header-host')
    const date = page.getByTestId('daily-note-date-label')
    const sync = page.getByTestId('daily-note-sync-chip')

    await expect(title).toHaveText('Daily note')
    await expect(header).toBeVisible({ timeout: 10_000 })
    await expect(date).toContainText('Jul 31, 2026')
    await expect(sync).toHaveAccessibleName(/Synced|Saving/)
    await expect(page.getByTestId('daily-note-today')).toHaveCount(0)
    await expect(page.locator('.daily-note-editor-toolbar')).toHaveCount(0)
    expect(
      await header.evaluate(
        (el) => el.closest('.topbar')?.querySelector('[data-testid="main-title"]')?.textContent === 'Daily note'
      )
    ).toBe(true)
    await expect(date).toHaveCSS('font-size', '11.5px')
    await expect(sync).toHaveCSS('font-size', '10.5px')
    await expect(sync).toHaveCSS('border-top-width', '0px')

    const titleBox = await title.boundingBox()
    const dateBox = await date.boundingBox()
    const syncBox = await sync.boundingBox()
    expect(titleBox).not.toBeNull()
    expect(dateBox).not.toBeNull()
    expect(syncBox).not.toBeNull()
    if (titleBox && dateBox && syncBox) {
      const centers = [titleBox, dateBox, syncBox].map((box) => box.y + box.height / 2)
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2)
      expect(titleBox.x).toBeLessThan(dateBox.x)
      expect(dateBox.x + dateBox.width).toBeLessThan(syncBox.x)
    }

    await expect(page.getByTestId('daily-note-editor-panel')).toBeVisible({ timeout: 10_000 })

    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible()
    const host = page.locator('.daily-note-atomic-host')
    const gutter = await host.evaluate((el) => {
      const style = getComputedStyle(el)
      const left = parseFloat(style.paddingLeft)
      const right = parseFloat(style.paddingRight)
      const width = el.clientWidth
      const minContent = parseFloat(style.getPropertyValue('--notes-editor-min-content')) || 480
      const padMax = parseFloat(style.getPropertyValue('--notes-editor-inline-pad-max')) || 200
      const expected = Math.min(padMax, Math.max(0, (width - minContent) / 2))
      return { left, right, width, minContent, padMax, expected }
    })
    expect(gutter.left).toBeCloseTo(gutter.right, 0)
    expect(gutter.left).toBeCloseTo(gutter.expected, 0)
    expect(gutter.width - gutter.left - gutter.right).toBeGreaterThanOrEqual(
      Math.min(gutter.minContent, gutter.width)
    )
    await expect(editor.locator('.cm-content').first()).toHaveCSS('font-size', '15.5px')
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('[data-testid="daily-note-editor"]') != null)
      )
      .toBe(true)
    await page.keyboard.press('End')
    await page.keyboard.type(`\n\n${UNIQUE_LINE}`)

    await expect
      .poll(() => readFileSync(notePath, 'utf-8'), { timeout: 15_000 })
      .toContain(UNIQUE_LINE)

    await expect(readFileSync(notePath, 'utf-8')).toMatch(/## 📝 Notes[\s\S]*Seed body before edit/)
    await expect(readFileSync(notePath, 'utf-8')).not.toMatch(/^## Notes$/m)
    await expect(page.getByTestId('daily-note-sync-chip')).toContainText(/Synced|Saving/, { timeout: 10_000 })

    await page.screenshot({ path: join(artifactsDir, 'daily-note-notes-editor-slice.png') })

    await page.getByTestId('daily-note-prev-day').click()
    await expect(date).toContainText('Jul 30, 2026')
    await page.getByTestId('daily-note-next-day').click()
    await expect(date).toContainText('Jul 31, 2026')
    await page.getByTestId('daily-note-editor').hover()
    await page.screenshot({ path: join(artifactsDir, 'daily-note-compact-header.png') })
  })

  test('external vault edit to ## Notes propagates into the Atomic editor', async () => {
    writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-editor')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('daily-note-editor').getByText('Seed body before edit.')).toBeVisible()

    const tmpPath = `${notePath}.obsidian-tmp`
    writeFileSync(tmpPath, fixtureWithNotesBody(EXTERNAL_NOTES_LINE), 'utf-8')
    renameSync(tmpPath, notePath)

    await expect(page.getByTestId('daily-note-editor').getByText(EXTERNAL_NOTES_LINE)).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByTestId('daily-note-sync-chip')).toHaveText('Updated from vault', { timeout: 10_000 })

    await page.screenshot({ path: join(artifactsDir, 'daily-note-notes-editor-external-sync.png') })
  })

  test('local typing is not interrupted by self-write vault sync', async () => {
    writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

    await page.getByTestId('daily-note-row').click()
    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await editor.click()

    for (let i = 0; i < 8; i++) {
      await page.keyboard.type('a')
      await page.waitForTimeout(80)
    }

    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="daily-note-editor"]') != null
          ),
        { timeout: 5_000 }
      )
      .toBe(true)

    await page.waitForTimeout(900)
    await expect(page.getByTestId('daily-note-sync-chip')).not.toHaveText('Updated from vault')
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="daily-note-editor"]') != null
          ),
        { timeout: 2_000 }
      )
      .toBe(true)
  })

  test('pasting an image saves beside the note and inserts an Obsidian wiki embed', async () => {
    writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

    await page.getByTestId('daily-note-row').click()
    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible({ timeout: 10_000 })

    const redPng = buildSolidRedPng(8, 8)
    await dispatchEditorPaste(page, redPng, 'clipboard.png')

    await expect
      .poll(() => readFileSync(notePath, 'utf-8'), { timeout: 15_000 })
      .toMatch(/!\[\[Pasted image [^\]]+\.png\]\]/)

    const embedMatch = readFileSync(notePath, 'utf-8').match(/!\[\[([^\]]+\.png)\]\]/)
    expect(embedMatch).not.toBeNull()
    const imagePath = join(dirname(notePath), embedMatch![1]!)
    expect(existsSync(imagePath)).toBe(true)

    const previewImg = editor.locator('.cm-atomic-image img')
    await expect(previewImg).toBeVisible({ timeout: 10_000 })
    await expect(previewImg).toHaveAttribute('src', /^data:image\/png;base64,/)

    await page.screenshot({ path: join(artifactsDir, 'daily-note-notes-editor-pasted-image.png') })
  })

  test('markdown link icon opens in the external browser via shell.openExternal', async () => {
    const targetUrl = 'https://example.com/daily-note-editor-link-test'
    writeFileSync(
      notePath,
      fixtureWithNotesBody(`Seed body before edit.\n\n[Example Site](${targetUrl})`),
      'utf-8'
    )

    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        // @ts-expect-error test-only bookkeeping read back below
        globalThis.__lastOpenedExternalUrl = url
        return undefined
      }
    })

    await page.getByTestId('daily-note-row').click()
    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor.getByText('Example Site')).toBeVisible({ timeout: 10_000 })

    await clickAtomicEditorLinkIcon(page, editor)

    const openedUrl = await electronApp.evaluate(() => {
      // @ts-expect-error test-only bookkeeping
      return globalThis.__lastOpenedExternalUrl ?? null
    })
    expect(openedUrl).toBe(targetUrl)
    expect(page.url()).not.toContain('example.com')
  })

  test('Emacs Opt+F forward word works in daily note markdown editor', async () => {
    await page.getByTestId('daily-note-row').click()
    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await editor.locator('.cm-content').click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('hello world')
    await page.keyboard.press('Home')
    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Alt')
    await page.keyboard.type('!')
    await expect(editor.getByText('hello! world')).toBeVisible({ timeout: 5_000 })
  })
})
