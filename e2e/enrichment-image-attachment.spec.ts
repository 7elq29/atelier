import { test, expect, _electron as electron, type ElectronApplication, type ElementHandle, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const attachmentLogPath = join(artifactsDir, '10g.log')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

// ── Real PNG encoding (no fixture library available) ───────────────────────
// A from-scratch, spec-correct PNG encoder for a solid-color RGB image: PNG
// signature + IHDR/IDAT/IEND chunks, each with a real CRC-32 trailer (PNG
// requires a correct CRC or readers reject the file outright — a fake/stub
// image would fail to decode, which is exactly what the task asks to avoid).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** Builds a real, valid solid-red PNG (8-bit RGB) of the given size. */
function buildSolidRedPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor (RGB)
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize
    raw[rowStart] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3
      raw[px] = 255 // R
      raw[px + 1] = 0 // G
      raw[px + 2] = 0 // B
    }
  }
  const idat = deflateSync(raw)
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

/**
 * Dispatches a real `drop`/`paste` DOM event carrying a real `File` built
 * from `pngBytes`, targeting `selector`. Playwright has no built-in
 * OS-level drag simulation for Electron, so this follows the standard
 * documented recipe instead: build a real `DataTransfer` inside the page
 * (so `dataTransfer.files`/`clipboardData.items` are genuine, not mocked),
 * then dispatch a plain, bubbling `Event` with `dataTransfer`/`clipboardData`
 * attached via `Object.defineProperty` — necessary because Chromium's
 * `DragEvent`/`ClipboardEvent` constructors don't reliably accept
 * `dataTransfer`/`clipboardData` through their init dictionaries, but do
 * expose them as ordinary (definable) instance properties, which is all
 * React's synthetic event system reads off the native event during bubbling.
 */
async function dispatchFileEvent(
  page: Page,
  target: ElementHandle<Element>,
  eventType: 'drop' | 'paste',
  pngBytes: Buffer,
  fileName: string
): Promise<void> {
  await page.evaluate(
    ({ el, bytes, fileName, eventType }) => {
      const file = new File([new Uint8Array(bytes)], fileName, { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const event = new Event(eventType, { bubbles: true, cancelable: true })
      Object.defineProperty(event, eventType === 'drop' ? 'dataTransfer' : 'clipboardData', { value: dt })
      el.dispatchEvent(event)
    },
    { el: target, bytes: Array.from(pngBytes), fileName, eventType }
  )
}

/**
 * Appends the real main-process log (via `getLogFilePath()`) into the proof
 * artifact, filtered to the `harness.streamInput() called` lines this task
 * cares about — each is a JSON line carrying `contentBlockTypes`, the real
 * array of block types (`'text'`/`'image'`) the SDK call's `content` was
 * actually built with (see `ClaudeAgentSdkHarness.streamInput`), which is
 * the proof the SDK call received real image content and not just a text
 * mention of a file path.
 */
async function appendAttachmentLog(page: Page, label: string): Promise<string> {
  const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
  if (!existsSync(logFilePath)) return ''
  const raw = readFileSync(logFilePath, 'utf-8')
  const lines = raw.split('\n').filter((l) => l.includes('harness.streamInput() called'))
  const section = `[${label}]\n${lines.join('\n')}\n`
  writeFileSync(attachmentLogPath, section, { flag: 'a' })
  return section
}

test.describe.configure({ mode: 'serial' })

test.describe('10g-enrichment-image-attachment', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string
  const redPng = buildSolidRedPng(24, 24)

  test.beforeAll(async () => {
    writeFileSync(attachmentLogPath, '')
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-image-attach-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-image-attach-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 0. Create a real claude-code session ────────────────────────────────
  test('create session', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
  })

  // ── 1. Paste a real image into the composer ─────────────────────────────
  test('pasting a real image renders a thumbnail chip', async () => {
    const textarea = page.getByTestId('composer-input')
    await textarea.click()
    const handle = (await textarea.elementHandle()) as ElementHandle<Element>
    await dispatchFileEvent(page, handle, 'paste', redPng, 'clipboard.png')

    const thumb = page.getByTestId('composer-attach-thumb')
    await expect(thumb).toBeVisible({ timeout: 5_000 })
    const img = page.getByTestId('composer-attach-image')
    const src = await img.getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    // Remove it via the chip's (x) button before the drop test below —
    // single-image-at-a-time, per spec.md's minimal scope.
    await page.getByTestId('composer-attach-remove').click()
    await expect(thumb).toHaveCount(0)
  })

  // ── 2. Drag-and-drop a real image file onto the composer ────────────────
  test('dropping a real image file attaches the same way', async () => {
    const composerBox = page.locator('.composer-box')
    const handle = (await composerBox.elementHandle()) as ElementHandle<Element>
    await dispatchFileEvent(page, handle, 'drop', redPng, 'dropped.png')

    const thumb = page.getByTestId('composer-attach-thumb')
    await expect(thumb).toBeVisible({ timeout: 5_000 })
    const img = page.getByTestId('composer-attach-image')
    const src = await img.getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    await page.screenshot({ path: join(artifactsDir, '10g-image-attachment-chip.png') })
  })

  // ── 3. Send with the image still attached: real SDK image content block ─
  test('sending includes a real image content block, and Claude actually sees it', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    const textarea = page.getByTestId('composer-input')
    await textarea.fill('What is the dominant color of the attached image? Answer with just the color name.')
    await textarea.press('Enter')

    // Thumbnail clears on send, composer goes idle once the turn finishes.
    await expect(page.getByTestId('composer-attach-thumb')).toHaveCount(0)
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 60_000 })

    // 1) DB proof: the user message was persisted as an image_attachment,
    // not a plain-text mention of a file path.
    const userRows = await page.evaluate(
      (id) =>
        window.atelier.debugQueryDb<{ content: string }>(
          "SELECT content FROM messages WHERE session_id = ? AND role='user' ORDER BY id DESC LIMIT 1",
          [id]
        ),
      sessionId
    )
    const persisted = JSON.parse(userRows[0].content)
    expect(persisted.kind).toBe('image_attachment')
    expect(persisted.mimeType).toBe('image/png')
    expect(typeof persisted.data).toBe('string')
    expect(persisted.data.length).toBeGreaterThan(0)

    // 2) Real harness-log proof: the actual SDK call's content blocks
    // included 'image' (not just 'text') — logged straight from the exact
    // payload ClaudeAgentSdkHarness.streamInput() built and pushed onto the
    // SDK's own input queue, so this is not inferred from the UI.
    const logSection = await appendAttachmentLog(page, 'send-with-image')
    const streamInputLines = logSection
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { sessionId?: string; contentBlockTypes?: string[] })
      .filter((entry) => entry.sessionId === sessionId)
    expect(streamInputLines.length).toBeGreaterThan(0)
    const sawImageBlock = streamInputLines.some((entry) => entry.contentBlockTypes?.includes('image'))
    expect(sawImageBlock).toBe(true)

    // 3) Real model-response proof: Claude's actual reply is consistent
    // with the real test image (solid red) — not a canned/mocked answer.
    const assistantRows = await page.evaluate(
      (id) =>
        window.atelier.debugQueryDb<{ content: string }>(
          "SELECT content FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' ORDER BY id DESC LIMIT 1",
          [id]
        ),
      sessionId
    )
    expect(assistantRows[0]?.content ?? '').toMatch(/red/i)

    // 4) Transcript renders the sent image back (a thumbnail, in the user
    // message row), not just the text.
    const transcriptThumb = page.getByTestId('transcript-attach-thumb')
    await expect(transcriptThumb).toBeVisible()
    await expect(transcriptThumb.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  })
})
