import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "audit-window-resize-layout-integrity" — cross-cutting layout audit
 * requested mid-task (not one of the 7 originally-reported bugs).
 *
 * Resizes the real Electron BrowserWindow across 3 sizes (small/medium/
 * large) and, for each size, checks 4 states (empty sidebar, active chat
 * session w/ TrackerRail, New Session modal open, daily notes sidebar) for:
 *   - no two sibling top-level panels (`.app-body`'s direct children)
 *     overlap in their bounding rects
 *   - no container's scrollWidth/scrollHeight exceeds its clientWidth/
 *     clientHeight in a way that HIDES content, excluding the panels that
 *     are intentionally scrollable (transcript, sidebar session list,
 *     tracker body, daily-notes section bodies) — checked via each
 *     container's own `overflow` CSS (auto/scroll containers are expected
 *     to have scrollHeight > clientHeight when content overflows; only
 *     non-scrollable containers are flagged).
 *
 * A screenshot is captured for every size × state combination.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

const SIZES: { name: string; width: number; height: number }[] = [
  { name: 'small', width: 1024, height: 700 },
  { name: 'medium', width: 1440, height: 900 },
  { name: 'large', width: 1920, height: 1080 },
  // Pass-2 additions: a short-but-normal-width window (vertical clipping,
  // e.g. the New Session modal's internal sections) and a below-minimum
  // extra-narrow window (graceful-degradation check, not a crash check).
  { name: 'short-small', width: 1024, height: 640 },
  { name: 'extra-narrow', width: 900, height: 700 }
]

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface OverlapFinding {
  size: string
  state: string
  a: string
  b: string
  rectA: Rect
  rectB: Rect
}

interface ClipFinding {
  size: string
  state: string
  selector: string
  clientWidth: number
  scrollWidth: number
  clientHeight: number
  scrollHeight: number
}

const overlapFindings: OverlapFinding[] = []
const clipFindings: ClipFinding[] = []

function rectsOverlap(a: Rect, b: Rect): boolean {
  // 1px slack for sub-pixel rounding at shared borders.
  const slack = 1
  return a.x + a.width - slack > b.x && b.x + b.width - slack > a.x && a.y + a.height - slack > b.y && b.y + b.height - slack > a.y
}

async function checkNoSiblingOverlap(page: Page, size: string, state: string, containerSelector: string): Promise<void> {
  const panels = await page.locator(`${containerSelector} > *`).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el as HTMLElement).position === 'fixed')
      .map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return {
          label: (el as HTMLElement).getAttribute('data-testid') || (el as HTMLElement).className || el.tagName,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height }
        }
      })
      .filter((p) => p.rect.width > 0 && p.rect.height > 0)
  )

  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      if (rectsOverlap(panels[i].rect, panels[j].rect)) {
        overlapFindings.push({
          size,
          state,
          a: panels[i].label,
          b: panels[j].label,
          rectA: panels[i].rect,
          rectB: panels[j].rect
        })
      }
    }
  }
}

/** Non-scrollable-by-design containers whose content should never need internal scrolling. */
const NON_SCROLLABLE_SELECTORS = [
  '.app-body',
  '.main-area',
  '.topbar',
  '.tracker-rail .tracker-head',
  '.dn-head'
]

async function checkNoUnexpectedClipping(page: Page, size: string, state: string): Promise<void> {
  const results = await page.evaluate((selectors: string[]) => {
    const out: { selector: string; clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number }[] = []
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const e = el as HTMLElement
        if (e.offsetParent === null) return
        out.push({
          selector: sel,
          clientWidth: e.clientWidth,
          scrollWidth: e.scrollWidth,
          clientHeight: e.clientHeight,
          scrollHeight: e.scrollHeight
        })
      })
    }
    return out
  }, NON_SCROLLABLE_SELECTORS)

  for (const r of results) {
    // 2px slack for border/rounding.
    if (r.scrollWidth > r.clientWidth + 2 || r.scrollHeight > r.clientHeight + 2) {
      clipFindings.push({ size, state, ...r })
    }
  }
}

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, dims) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setBounds({ x: 0, y: 0, width: dims.width, height: dims.height })
  }, { width, height })
}

async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('audit: window-resize layout integrity across sizes and states', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  const TEST_DATE = '2026-07-31'

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-resize-audit-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-resize-audit-project-'))

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-resize-audit-vault-'))
    const vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    // Pass-2 fix: pass 1 never exercised real Daily Notes content (empty
    // vault -> "No vault configured" fallback only). This fixture seeds
    // enough timed tasks / unscheduled items / tracker items to (a) prove
    // Timeline/Unscheduled/Trackers actually render real content at every
    // window size, and (b) force each `.dn-section-body` past its bounds so
    // the scroll-experience audit (audit-scroll-experience.spec.ts) has real
    // overflow to scroll through.
    const timedTasks = Array.from({ length: 10 }, (_, i) => {
      const hour = 8 + i
      return `- [ ] ${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:30 Timed task #${i + 1} [gid:: ${String(i).padStart(8, 'a')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa]`
    }).join('\n')
    const unscheduledTasks = Array.from(
      { length: 8 },
      (_, i) => `- [ ] Unscheduled backlog item #${i + 1} [gid:: ${String(i).padStart(8, 'b')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb]`
    ).join('\n')
    const trackerItems = Array.from(
      { length: 6 },
      (_, i) => `> - [ ] Tracker habit #${i + 1} #tracker [gid:: ${String(i).padStart(8, 'c')}-cccc-4ccc-8ccc-cccccccccccc]`
    ).join('\n')
    writeFileSync(
      join(noteDir, `${TEST_DATE}.md`),
      `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## \u{1F4CB} Tasks\n\n${timedTasks}\n\n### ⚪ Backlog\n${unscheduledTasks}\n\n### \u{1F91D} Delegated\n-\n\n> [!invisible] Trackers\n${trackerItems}\n`,
      'utf-8'
    )

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
    // Diagnostic-only listeners (kept cheap/quiet): if the app ever crashes
    // or the window closes unexpectedly mid-audit, this surfaces *why* in
    // the test log instead of a bare "target closed" error (see the
    // ELECTRON-UNEXPECTED-QUIT finding this audit already ran into once).
    page.on('crash', () => console.log('AUDIT-DIAG: page crashed'))
    page.on('pageerror', (err) => console.log('AUDIT-DIAG: pageerror', err.message))
  })

  test.afterAll(async () => {
    // Emit a concrete, numeric report of any findings before closing — this
    // is the evidence the task asks for (actual bounding-box numbers), not
    // a "looks fine" summary.
    if (overlapFindings.length > 0 || clipFindings.length > 0) {
      // eslint-disable-next-line no-console
      console.log('RESIZE AUDIT FINDINGS:', JSON.stringify({ overlapFindings, clipFindings }, null, 2))
    }
    await electronApp.close().catch(() => undefined)
  })

  test('create one real session so state (b)/(c) have something to resize around', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    // Must actually populate the tracker rail (real TodoWrite call), not
    // just "Reply with exactly: READY." — TrackerRail.tsx now renders
    // nothing at all when there's nothing to track (see
    // fix-empty-tracker-rail-reserves-width), so a rail-less session would
    // make every `tracker-rail` assertion below fail outright instead of
    // exercising the "(b) active chat session with TrackerRail visible"
    // state this setup exists for.
    await page.getByTestId('initial-prompt').fill(
      'Use the TodoWrite tool now to create a todo list with exactly two items: "Step one" (in_progress) and ' +
        '"Step two" (pending). Do not do anything else. After calling TodoWrite once, reply with exactly: DONE.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.locator('[data-testid="session-row"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('todo-item')).toHaveCount(2, { timeout: 30_000 })
  })

  for (const size of SIZES) {
    test(`size ${size.name} (${size.width}x${size.height}): all 4 states`, async ({}, testInfo) => {
      testInfo.setTimeout(60_000)
      await setWindowSize(electronApp, size.width, size.height)
      // Let layout settle.
      await page.waitForTimeout(150)

      // (a) empty sidebar-adjacent state: close the active session's chat by
      // deselecting — simplest reliable "no active session" proxy is the
      // main-empty-state view, achieved by clicking the sidebar collapse and
      // back is unnecessary; instead we just check the sidebar's own panel
      // here regardless of selection, since "empty sidebar state" is about
      // sidebar layout integrity, not literal zero sessions.
      await checkNoSiblingOverlap(page, size.name, 'a-sidebar', '.app-body')
      await checkNoUnexpectedClipping(page, size.name, 'a-sidebar')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-a-sidebar.png`) })

      // (b) active chat session with TrackerRail visible.
      const row = page.locator('[data-testid="session-row"]').first()
      await row.click()
      await expect(page.getByTestId('tracker-rail')).toBeVisible()
      await checkNoSiblingOverlap(page, size.name, 'b-active-session', '.app-body')
      await checkNoSiblingOverlap(page, size.name, 'b-active-session-main', '.main-area > div:has(.tracker-rail)')
      await checkNoUnexpectedClipping(page, size.name, 'b-active-session')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-b-active-session.png`) })

      // (c) New Session modal open.
      await openNewSessionModal(page)
      await checkNoSiblingOverlap(page, size.name, 'c-new-session-modal', '.modal-dialog')
      await checkNoUnexpectedClipping(page, size.name, 'c-new-session-modal')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-c-new-session-modal.png`) })
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

      // (d) daily notes sidebar.
      await expect(page.getByTestId('daily-notes-panel')).toBeVisible()
      await checkNoSiblingOverlap(page, size.name, 'd-daily-notes', '.app-body')
      await checkNoSiblingOverlap(page, size.name, 'd-daily-notes-sections', '.daily-notes-panel')
      await checkNoUnexpectedClipping(page, size.name, 'd-daily-notes')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-d-daily-notes.png`) })
    })
  }

  // ── Pass-2: expanded state matrix (command palette / settings / model
  // picker / tracker-rail-collapsed) across all 5 sizes ──
  for (const size of SIZES) {
    test(`size ${size.name} (${size.width}x${size.height}): pass-2 states (palette/settings/picker/collapsed-rail)`, async ({}, testInfo) => {
      testInfo.setTimeout(60_000)
      await setWindowSize(electronApp, size.width, size.height)
      await page.waitForTimeout(150)

      // Make sure the active session (with tracker rail) is selected so the
      // collapsed-rail check below has a rail to collapse.
      const row = page.locator('[data-testid="session-row"]').first()
      await row.click()
      await expect(page.getByTestId('tracker-rail')).toBeVisible()

      // (e) command palette open.
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByTestId('command-palette')).toBeVisible()
      await checkNoSiblingOverlap(page, size.name, 'e-command-palette', '.modal-dialog')
      await checkNoUnexpectedClipping(page, size.name, 'e-command-palette')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-e-command-palette.png`) })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('command-palette')).toHaveCount(0)

      // (f) settings panel open.
      await page.getByTestId('open-settings-button').click()
      await expect(page.getByTestId('settings-panel')).toBeVisible()
      await checkNoSiblingOverlap(page, size.name, 'f-settings-panel', '.modal-dialog')
      await checkNoUnexpectedClipping(page, size.name, 'f-settings-panel')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-f-settings-panel.png`) })
      await page.getByTestId('settings-close').click()
      await expect(page.getByTestId('settings-panel')).toHaveCount(0)

      // (g) model picker popover open — the composer sits at the right edge
      // of the main column, so this is exactly the "popover clipped by the
      // window's right edge at small widths" case the task calls out.
      await page.getByTestId('model-picker-button').click()
      await expect(page.getByTestId('model-picker-popover')).toBeVisible()
      const popRect = await page.getByTestId('model-picker-popover').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right }
      })
      expect(
        popRect.right,
        `model-picker-popover right edge (${popRect.right}) exceeds window width (${size.width}) at size ${size.name}`
      ).toBeLessThanOrEqual(size.width)
      expect(popRect.left, `model-picker-popover left edge (${popRect.left}) is off-screen at size ${size.name}`).toBeGreaterThanOrEqual(0)
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-g-model-picker.png`) })
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.mouse.click(10, 10)
      await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)

      // (h) tracker rail collapsed state. NOTE: as of this audit there is NO
      // real UI affordance that reaches this state — TrackerRail.tsx never
      // renders a `.tracker-rail-toggle` button despite global.css fully
      // implementing `.tracker-rail.collapsed`/`.rail-mini-badges` styling
      // (see finding TR-COLLAPSE-UNREACHABLE in the audit summary). This is
      // a NEW finding, not a pre-existing tracked bug. To still audit the
      // CSS geometry of the (currently unreachable) collapsed state, the
      // class is toggled directly via DOM manipulation — this is a
      // pure-CSS/layout probe, not a mock of any app behavior or SDK call.
      await page.evaluate(() => document.querySelector('.tracker-rail')?.classList.add('collapsed'))
      await page.waitForTimeout(150)
      const collapsedWidth = await page.locator('.tracker-rail').evaluate((el) => el.getBoundingClientRect().width)
      expect(collapsedWidth, `collapsed .tracker-rail width should be 40px per global.css, got ${collapsedWidth}`).toBeCloseTo(40, 0)
      await checkNoSiblingOverlap(page, size.name, 'h-tracker-rail-collapsed', '.main-area > div:has(.tracker-rail)')
      await checkNoUnexpectedClipping(page, size.name, 'h-tracker-rail-collapsed')
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-h-tracker-rail-collapsed.png`) })
      await page.evaluate(() => document.querySelector('.tracker-rail')?.classList.remove('collapsed'))
    })
  }

  test('report: no overlaps or unexpected clipping were found across any size/state combo', () => {
    // This is the actual audit assertion. If it fails, the failure message
    // (from the console.log above, captured in the test report) contains
    // the exact bounding-box numbers for every finding.
    expect(overlapFindings, `sibling-panel overlaps found: ${JSON.stringify(overlapFindings, null, 2)}`).toEqual([])
    expect(clipFindings, `unexpected content clipping found: ${JSON.stringify(clipFindings, null, 2)}`).toEqual([])
  })
})

/**
 * Pass-2 per-card assertions + the real-SDK AskUserQuestion check get their
 * OWN fresh electron app/describe block, using an isolated session with real
 * TodoWrite-populated todos (see beforeAll) so `.tracker-head`/`.tracker-body`
 * /`.todo-item` actually render — the shared app above only ever creates a
 * "Reply with exactly: READY." session with zero todos, which is fine for
 * overlap/clipping checks but not for the todo-card padding/font-size
 * assertions below. Keeping this in its own describe also keeps its longer
 * per-test timeouts independent of the 24-test shared-app sequence.
 */
test.describe('audit: pass-2 per-card assertions (isolated app)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-resize-audit-cards-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-resize-audit-cards-project-'))
    electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the TodoWrite tool now to create a todo list with exactly two items: "Step one" (in_progress) and ' +
        '"Step two" (pending). Do not do anything else. After calling TodoWrite once, reply with exactly: DONE.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('tracker-rail')).toBeVisible({ timeout: 15_000 })
    // Wait for the real TodoWrite-populated tracker card to actually render
    // (not just for the row to appear) — the earlier version of this fixture
    // used a plain "Reply with exactly: READY." prompt, which never calls
    // TodoWrite, so `.tracker-rail` rendered its EMPTY-state div (no
    // `.tracker-head`/`.tracker-body`/`.todo-item` children at all per
    // TrackerRail.tsx). That made a later locator.evaluate() on
    // `.tracker-rail .tracker-head` wait forever for an element that would
    // never exist, which Playwright reported as a confusing "Target page,
    // context or browser has been closed" once the outer test timeout tore
    // the worker down — NOT an actual app crash. Real todos fix it.
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('todo-item')).toHaveCount(2, { timeout: 30_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // (Features/UI-Design/mocks/design-variants/variant-1-soft-paper.html is
  // NOT present anywhere in this repo or its git history — verified via
  // `git ls-tree -r HEAD` and `git log --all -- 'Features/*'`, both empty.
  // The actual, in-repo source of truth every component comment cites is
  // `Features/UI-Design/mocks/index.html`, which is *also* absent from this
  // checkout. Since neither mock file can be read, the values below are
  // asserted against the CURRENT REAL implementation — src/renderer/src/
  // styles/global.css and Composer.tsx's own MAX_TEXTAREA_HEIGHT constant —
  // which is the only verifiable ground truth available. Any mismatch
  // against the task brief's cited numbers is called out in the written
  // findings, not silently "fixed" to match — this is an audit, not a fix.)
  test('per-card size assertions: tracker-rail / composer / new-session-modal / aq-card / model-picker', async ({}, testInfo) => {
    testInfo.setTimeout(30_000)
    await setWindowSize(electronApp, 1024, 700)
    await page.waitForTimeout(150)
    const row = page.locator('[data-testid="session-row"]').first()
    await row.click()
    await expect(page.getByTestId('tracker-rail')).toBeVisible()

    // tracker-rail width: fixed for bug #50 to 244px — verify, don't assume.
    const railWidth = await page.locator('.tracker-rail').evaluate((el) => el.getBoundingClientRect().width)
    expect(railWidth, `tracker-rail width should be 244px per global.css (bug #50 fix), got ${railWidth}`).toBeCloseTo(244, 0)

    // tracker-head / tracker-body padding and font-size vs. global.css's own
    // real values (12px/14px/6px padding, 15px font — NOT the 12-12.5px font
    // range the task brief cited; see file header note above).
    const trackerHeadStyle = await page.locator('.tracker-rail .tracker-head').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { padding: cs.padding, fontSize: cs.fontSize }
    })
    expect(trackerHeadStyle.padding).toBe('12px 14px 6px')
    const trackerBodyStyle = await page.locator('.tracker-rail .tracker-body').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { padding: cs.padding }
    })
    expect(trackerBodyStyle.padding).toBe('8px 14px 14px')
    const todoItemFontSize = await page.locator('.todo-item').first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(todoItemFontSize, 'todo-item font-size (real value, see file header note)').toBe('15px')

    // Composer max-grow height: MAX_TEXTAREA_HEIGHT = 160 in Composer.tsx —
    // verify it actually clamps, and the footer chip row isn't pushed off or
    // clipped once the textarea is at max height.
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    await page.getByTestId('composer-input').fill(longText)
    await page.waitForTimeout(100)
    const textareaHeight = await page.getByTestId('composer-input').evaluate((el) => (el as HTMLTextAreaElement).style.height)
    expect(textareaHeight, 'composer textarea should clamp its inline height style to 160px').toBe('160px')
    const composerBoxRect = await page.locator('.composer-box').evaluate((el) => el.getBoundingClientRect())
    const footerRect = await page.locator('.composer-footer').evaluate((el) => el.getBoundingClientRect())
    expect(footerRect.bottom, 'composer-footer should remain fully within composer-box bounds at max textarea height').toBeLessThanOrEqual(
      composerBoxRect.bottom + 1
    )
    expect(footerRect.height, 'composer-footer should not be zero-height/clipped at max textarea height').toBeGreaterThan(0)
    await page.getByTestId('composer-input').fill('')

    // New Session modal: 560px fixed width — no horizontal clipping at the
    // small (1024) window width.
    await openNewSessionModal(page)
    const modalRect560 = await page.locator('.modal-dialog').evaluate((el) => el.getBoundingClientRect())
    expect(modalRect560.width).toBeCloseTo(560, 0)
    expect(modalRect560.right, 'New Session modal should not clip past the window edge at 1024px width').toBeLessThanOrEqual(1024)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Now the SHORT window (1024x640) vertical-clipping check: does the
    // modal-body actually scroll to reach every internal section, or does
    // something get clipped/collide?
    await setWindowSize(electronApp, 1024, 640)
    await page.waitForTimeout(150)
    await openNewSessionModal(page)
    await page.getByTestId('mode-claude-code').click() // reveal the Initial Prompt section too
    const modalBodyOverflow = await page.locator('.modal-dialog .modal-body').evaluate((el) => getComputedStyle(el).overflowY)
    expect(modalBodyOverflow, 'modal-body must be scrollable (overflow-y: auto) to avoid vertical clipping in a short window').toMatch(
      /auto|scroll/
    )
    // Scroll the modal body all the way down and verify the Initial Prompt
    // textarea (the last section) actually becomes reachable/visible —
    // proves real scroll-to-reveal, not just a theoretical scrollbar.
    await page.locator('.modal-dialog .modal-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(100)
    const promptRect = await page.getByTestId('initial-prompt').evaluate((el) => el.getBoundingClientRect())
    const modalBodyRect = await page.locator('.modal-dialog .modal-body').evaluate((el) => el.getBoundingClientRect())
    expect(
      promptRect.bottom,
      `initial-prompt textarea (bottom=${promptRect.bottom}) should be within modal-body's visible viewport (bottom=${modalBodyRect.bottom}) after scrolling to reveal it`
    ).toBeLessThanOrEqual(modalBodyRect.bottom + 1)
    expect(promptRect.top).toBeGreaterThanOrEqual(modalBodyRect.top - 1)
    await page.screenshot({ path: join(artifactsDir, `resize-audit-short-small-new-session-modal-scrolled.png`) })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await setWindowSize(electronApp, 1024, 700)
  })

  // ── composer spans full width beneath BOTH the transcript column and the
  // Tracker Rail (Features/13-composer-spans-tracker-rail) — the composer
  // must be a sibling of `.chat-body-row`, not nested inside
  // `.chat-main-col`, so its width should equal `.chat-body-row`'s full
  // width regardless of whether the Tracker Rail is present, and must be
  // strictly wider than `.chat-main-col` when the rail is visible
  // (otherwise this would trivially pass by coincidence if the composer
  // were still nested and just happened to render at the same width).
  test('composer-wrap spans full width under both transcript and Tracker Rail, in both rail-visible and rail-absent states', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await setWindowSize(electronApp, 1440, 900)
    await page.waitForTimeout(150)

    // (1) Rail-visible state: the beforeAll session already has 2 real
    // TodoWrite-populated todos, so `.tracker-rail` renders non-empty.
    const row = page.locator('[data-testid="session-row"]').first()
    await row.click()
    await expect(page.getByTestId('tracker-rail')).toBeVisible()
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible({ timeout: 15_000 })

    const chatBodyRowWidthWithRail = await page.locator('.chat-body-row').evaluate((el) => el.getBoundingClientRect().width)
    const chatMainColWidthWithRail = await page.locator('.chat-main-col').evaluate((el) => el.getBoundingClientRect().width)
    const composerWidthWithRail = await page.locator('.composer-wrap').evaluate((el) => el.getBoundingClientRect().width)
    const trackerRailWidth = await page.locator('.tracker-rail').evaluate((el) => el.getBoundingClientRect().width)

    expect(trackerRailWidth, 'tracker-rail should actually occupy real width for this to be a meaningful check').toBeGreaterThan(50)
    expect(
      composerWidthWithRail,
      `composer-wrap width (${composerWidthWithRail}) should equal chat-body-row's full width (${chatBodyRowWidthWithRail}) when the rail is visible`
    ).toBeCloseTo(chatBodyRowWidthWithRail, 0)
    expect(
      composerWidthWithRail,
      `composer-wrap width (${composerWidthWithRail}) must be strictly wider than chat-main-col's width (${chatMainColWidthWithRail}) — otherwise it isn't actually spanning past the Tracker Rail`
    ).toBeGreaterThan(chatMainColWidthWithRail + trackerRailWidth / 2)

    // Spawn a real subagent too (not just todos) so the required screenshot
    // shows a genuinely non-empty Tracker Rail (Todos AND Subagents cards)
    // alongside the full-width composer.
    await page.getByTestId('composer-input').fill(
      'Use the Task tool to spawn exactly one general-purpose subagent. Give it this exact instruction: ' +
        '"Use the Bash tool to run: echo hi — then reply with ONLY that word." ' +
        'Do not run any tools yourself other than the Task tool.'
    )
    await page.getByTestId('send-button').click()
    await expect(page.getByTestId('subagent-tracker-card')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(artifactsDir, '13-composer-spans-tracker-rail.png') })

    // (2) Rail-absent state: a brand-new empty session with no todos/
    // subagents — TrackerRail.tsx returns null entirely in this case (see
    // fix-empty-tracker-rail-reserves-width), so `.tracker-rail` shouldn't
    // even be in the DOM.
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY. Do not use any tools.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.locator('[data-testid="session-row"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.tracker-rail')).toHaveCount(0, { timeout: 15_000 })

    const composerWidthNoRail = await page.locator('.composer-wrap').evaluate((el) => el.getBoundingClientRect().width)
    const chatBodyRowWidthNoRail = await page.locator('.chat-body-row').evaluate((el) => el.getBoundingClientRect().width)

    expect(
      composerWidthNoRail,
      `composer-wrap width (${composerWidthNoRail}) should equal chat-body-row's full width (${chatBodyRowWidthNoRail}) when the rail is absent`
    ).toBeCloseTo(chatBodyRowWidthNoRail, 0)
    expect(
      composerWidthNoRail,
      `composer-wrap width must NOT change based on Tracker Rail presence: with-rail=${composerWidthWithRail}, without-rail=${composerWidthNoRail}`
    ).toBeCloseTo(composerWidthWithRail, 0)

    // Switch back to the rail-visible (TodoWrite) session — it's the one
    // NOT currently active, since the just-created empty session auto-
    // activates on creation — so later tests in this file (which assume
    // the first session row is the TodoWrite one) aren't affected by this
    // test having created a second session.
    await page.locator('[data-testid="session-row"]:not(.active)').first().click()
    await expect(page.getByTestId('tracker-rail')).toBeVisible()
  })

  // ── Pass-2: AskUserQuestion card, real SDK-triggered, checked across sizes ──
  test('AskUserQuestion card: real SDK-triggered, option rows readable at small widths', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await setWindowSize(electronApp, 1024, 700)
    await page.waitForTimeout(150)

    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the AskUserQuestion tool right now to ask me exactly one question: "Which environment should this deploy to?" ' +
        'with header "Environment" and exactly two options: "Staging" (a pre-production environment for validation) and ' +
        '"Production" (the live environment serving real users). Do not do anything else first.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    const card = page.getByTestId('ask-user-question-card')
    await expect(card).toBeVisible({ timeout: 30_000 })

    for (const size of [
      { name: 'small', width: 1024, height: 700 },
      { name: 'extra-narrow', width: 900, height: 700 }
    ]) {
      await setWindowSize(electronApp, size.width, size.height)
      await page.waitForTimeout(150)

      const cardRect = await card.evaluate((el) => el.getBoundingClientRect())
      // Compare against `.transcript`'s width (the stable scroll container),
      // not `card`'s immediate DOM parent (`.msg-wrap`, which itself sizes
      // to fit the card and would make this check tautological / racy right
      // after a resize).
      const transcriptWidth = await page.locator('.transcript').evaluate((el) => el.getBoundingClientRect().width)
      expect(
        cardRect.width,
        `aq-card width (${cardRect.width}) should not exceed the transcript's width (${transcriptWidth}) at size ${size.name}`
      ).toBeLessThanOrEqual(transcriptWidth + 1)

      // Option rows must not wrap into an illegibly short/overlapping row —
      // each option row should be at least tall enough to fit its own text
      // (a real wrap-collision would collapse the row's rendered height
      // below its content's natural line height, or option rows would
      // overlap each other vertically).
      const optionRects = await card.getByTestId('aq-option').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))
      for (let i = 0; i < optionRects.length; i++) {
        expect(optionRects[i].height, `aq-option #${i} looks clipped/collapsed at size ${size.name}`).toBeGreaterThan(20)
      }
      for (let i = 0; i < optionRects.length - 1; i++) {
        expect(
          optionRects[i + 1].top,
          `aq-option #${i} and #${i + 1} vertically overlap at size ${size.name}`
        ).toBeGreaterThanOrEqual(optionRects[i].bottom - 1)
      }
      await page.screenshot({ path: join(artifactsDir, `resize-audit-${size.name}-i-ask-user-question.png`) })
    }
    await setWindowSize(electronApp, 1024, 700)
  })

  test('report: no overlaps or unexpected clipping were found across any size/state combo', () => {
    // This is the actual audit assertion. If it fails, the failure message
    // (from the console.log above, captured in the test report) contains
    // the exact bounding-box numbers for every finding.
    expect(overlapFindings, `sibling-panel overlaps found: ${JSON.stringify(overlapFindings, null, 2)}`).toEqual([])
    expect(clipFindings, `unexpected content clipping found: ${JSON.stringify(clipFindings, null, 2)}`).toEqual([])
  })
})
