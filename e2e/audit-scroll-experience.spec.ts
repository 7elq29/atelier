import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "audit-scroll-experience" — pass-2 deepening of the window-resize audit
 * (#55). Pass 1 (audit-window-resize-layout.spec.ts) only ever checked
 * scrollWidth/clientWidth *metrics*; it never proved a user can actually
 * reach clipped content by scrolling. This file:
 *   1. Asserts every container that's SUPPOSED to scroll really has
 *      `overflow-y: auto|scroll`, then programmatically scrolls it
 *      (`el.scrollTop = el.scrollHeight`) and asserts the last real item's
 *      `getBoundingClientRect()` actually lands inside the container's
 *      visible viewport afterward.
 *   2. Asserts containers that should NOT scroll (topbar, composer footer)
 *      don't have an accidental inner scrollbar.
 *   3. Seeds a real fixture vault (ATELIER_TEST_VAULT_ROOT) with enough
 *      timed/unscheduled/tracker items to force real overflow in Daily
 *      Notes' three sections — fixing pass 1's "never saw real vault
 *      content" gap.
 *   4. Verifies (or disproves, with numbers) transcript auto-scroll-to-
 *      bottom on new messages, using real SDK turns (no mocking).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, dims) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setBounds({ x: 0, y: 0, width: dims.width, height: dims.height })
  }, { width, height })
}


async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

/** Scrolls `selector`'s element to its bottom and returns before/after scrollTop plus whether it moved at all. */
async function scrollToBottom(page: Page, selector: string): Promise<{ before: number; after: number; scrollHeight: number; clientHeight: number }> {
  return page.locator(selector).first().evaluate((el) => {
    const before = el.scrollTop
    el.scrollTop = el.scrollHeight
    return { before, after: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

async function computedOverflowY(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).overflowY)
}

/** Verifies `itemSelector`'s LAST matching element is within `containerSelector`'s visible viewport rect. */
async function lastItemVisibleWithin(page: Page, containerSelector: string, itemSelector: string): Promise<{ itemRect: DOMRect; containerRect: DOMRect }> {
  return page.evaluate(
    ({ containerSelector, itemSelector }) => {
      const container = document.querySelector(containerSelector) as HTMLElement
      const items = Array.from(container.querySelectorAll(itemSelector))
      const last = items[items.length - 1] as HTMLElement
      return { itemRect: last.getBoundingClientRect().toJSON(), containerRect: container.getBoundingClientRect().toJSON() }
    },
    { containerSelector, itemSelector }
  )
}

test.describe('audit: real scroll-experience verification (not just overflow metrics)', () => {
  // NOT `mode: 'serial'` deliberately: tests here build on shared state
  // (session count, window size) in declaration order, which Playwright
  // already guarantees for a single spec file in one worker — but `serial`
  // additionally SKIPS every remaining test in the group after one failure,
  // and this audit expects some assertions to genuinely fail (documenting
  // real bugs) without that hiding the rest of the audit's results.

  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  const TEST_DATE = '2026-07-31'

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-scroll-audit-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-scroll-audit-project-'))

    // A project with many files, so the `@`-mention popover has enough
    // matches to actually overflow its own 220px max-height.
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(projectDir, `file-${String(i).padStart(2, '0')}.txt`), `contents ${i}\n`)
    }

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-scroll-audit-vault-'))
    const vaultRoot = join(vaultParent, 'vault')
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    // Fill through 21:30 so scrolling the fixed 06:00–22:00 schedule to its
    // bottom actually surfaces the last real block instead of only trailing
    // empty hours.
    const timedTasks = Array.from({ length: 16 }, (_, i) => {
      const hour = 6 + i
      return `- [ ] ${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:30 Timed task #${i + 1} [gid:: ${String(i).padStart(8, 'a')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa]`
    }).join('\n')
    const unscheduledTasks = Array.from(
      { length: 12 },
      (_, i) => `- [ ] Unscheduled backlog item #${i + 1} [gid:: ${String(i).padStart(8, 'b')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb]`
    ).join('\n')
    const trackerItems = Array.from(
      { length: 10 },
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
    await expect(page.getByTestId('timeline-open-schedule')).toBeVisible()
    await page.getByTestId('timeline-open-schedule').click()
    await expect(page.getByTestId('daily-panel-schedule-view')).toBeVisible()
    // Shrink to the short-small size so the seeded content is guaranteed to
    // overflow the (now vertically constrained) daily-notes sections.
    await setWindowSize(electronApp, 1024, 640)
    await page.waitForTimeout(150)
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('daily notes: Timeline/Unscheduled/Trackers actually render real seeded content (fixes pass-1 empty-vault gap)', async () => {
    await expect(page.getByTestId('timeline-task').first()).toBeVisible()
    await expect(page.getByTestId('unscheduled-task').first()).toBeVisible()
    await expect(page.getByTestId('tracker-task').first()).toBeVisible()
    const counts = {
      timeline: await page.getByTestId('timeline-task').count(),
      unscheduled: await page.getByTestId('unscheduled-task').count(),
      tracker: await page.getByTestId('tracker-task').count()
    }
    expect(counts.timeline).toBe(16)
    expect(counts.unscheduled).toBe(12)
    expect(counts.tracker).toBe(10)
    await page.screenshot({ path: join(artifactsDir, 'scroll-audit-daily-notes-seeded-content.png') })
  })

  test('daily notes sections: overflow-y is auto AND scrolling to bottom surfaces the last real item', async () => {
    for (const { container, item, label } of [
      { container: '[data-testid="timeline-body"]', item: '[data-testid="timeline-task"]', label: 'timeline' },
      { container: '[data-testid="unscheduled-body"]', item: '[data-testid="unscheduled-task"]', label: 'unscheduled' },
      { container: '[data-testid="trackers-body"]', item: '[data-testid="tracker-task"]', label: 'trackers' }
    ]) {
      const overflowY = await computedOverflowY(page, container)
      expect(overflowY, `${label} body should have overflow-y auto/scroll`).toMatch(/auto|scroll/)

      const scroll = await scrollToBottom(page, container)
      // eslint-disable-next-line no-console
      console.log(`SCROLL-AUDIT[${label}]`, JSON.stringify(scroll))
      // Only meaningful if content actually overflowed the container.
      if (scroll.scrollHeight > scroll.clientHeight + 2) {
        const { itemRect, containerRect } = await lastItemVisibleWithin(page, container, item)
        expect(
          itemRect.bottom,
          `${label}: last item bottom (${itemRect.bottom}) should be within container's visible bottom (${containerRect.bottom}) after scrolling`
        ).toBeLessThanOrEqual(containerRect.bottom + 1)
        expect(itemRect.top, `${label}: last item top (${itemRect.top}) should be at/after container's visible top (${containerRect.top})`).toBeGreaterThanOrEqual(
          containerRect.top - 1
        )
      }
    }
    await page.screenshot({ path: join(artifactsDir, 'scroll-audit-daily-notes-scrolled-to-bottom.png') })
  })

  test('non-scrollable-by-design containers (topbar, composer footer) have no accidental inner scrollbar', async () => {
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    // claude-code mode (not terminal): `.composer-footer` only exists in the
    // chat surface, which terminal-mode sessions don't render. No initial
    // prompt is given, so no real SDK turn/cost is incurred — just the
    // harness connecting.
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.locator('[data-testid="session-row"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.composer-footer')).toBeVisible({ timeout: 15_000 })

    for (const selector of ['.topbar', '.composer-footer']) {
      const overflowY = await computedOverflowY(page, selector)
      expect(overflowY, `${selector} should not be an auto/scroll container by design`).not.toMatch(/^(auto|scroll)$/)
      const metrics = await page.locator(selector).first().evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }))
      expect(
        metrics.scrollHeight,
        `${selector} should not have accumulated an internal scrollbar (scrollHeight ${metrics.scrollHeight} vs clientHeight ${metrics.clientHeight})`
      ).toBeLessThanOrEqual(metrics.clientHeight + 2)
    }
  })

  test('sidebar session list: overflow-y auto, and scrolling to bottom surfaces the last real session row', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    const before = await page.locator('[data-testid="session-row"]').count()
    // Create enough terminal-mode sessions (real, but no SDK turn — fast) to
    // force the session list past its own height at the short-small window
    // size already in effect from beforeAll.
    for (let i = 0; i < 10; i++) {
            await openNewSessionModal(page)
      await page.getByTestId('project-path').fill(projectDir)
      await page.getByTestId('mode-terminal').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    }
    await expect(page.locator('[data-testid="session-row"]')).toHaveCount(before + 10)
    await page.waitForTimeout(150)

    const overflowY = await computedOverflowY(page, '.session-list')
    expect(overflowY, 'session-list should have overflow-y auto').toMatch(/auto|scroll/)

    const scroll = await scrollToBottom(page, '.session-list')
    // eslint-disable-next-line no-console
    console.log('SCROLL-AUDIT[session-list]', JSON.stringify(scroll))
    expect(scroll.scrollHeight, 'session-list should actually overflow with 11 sessions at 640px window height').toBeGreaterThan(scroll.clientHeight)

    const { itemRect, containerRect } = await lastItemVisibleWithin(page, '.session-list', '[data-testid="session-row"]')
    expect(itemRect.bottom, 'last session row should be visible within session-list after scrolling to bottom').toBeLessThanOrEqual(
      containerRect.bottom + 1
    )
    await page.screenshot({ path: join(artifactsDir, 'scroll-audit-session-list-scrolled.png') })
  })

  test('mention popover: overflow-y auto with many matches, scrolling to bottom surfaces the last match', async () => {
    // Open a claude-code-mode session so the composer (with @-mention wired
    // to a real project file list) is present; no message is sent, so no
    // real SDK turn/cost is incurred by this test.
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('composer-input').fill('@file-')
    const popover = page.getByTestId('mention-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByTestId('mention-item')).toHaveCount(20) // MAX_MENTION_MATCHES cap in Composer.tsx, out of 25 real files

    const overflowY = await computedOverflowY(page, '[data-testid="mention-popover"]')
    expect(overflowY, 'mention-popover should have overflow-y auto per global.css').toMatch(/auto|scroll/)

    const scroll = await scrollToBottom(page, '[data-testid="mention-popover"]')
    // eslint-disable-next-line no-console
    console.log('SCROLL-AUDIT[mention-popover]', JSON.stringify(scroll))
    if (scroll.scrollHeight > scroll.clientHeight + 2) {
      const { itemRect, containerRect } = await lastItemVisibleWithin(page, '[data-testid="mention-popover"]', '[data-testid="mention-item"]')
      expect(itemRect.bottom, 'last mention-item should be visible after scrolling the popover to bottom').toBeLessThanOrEqual(containerRect.bottom + 1)
    }
    await page.screenshot({ path: join(artifactsDir, 'scroll-audit-mention-popover.png') })
    await page.getByTestId('composer-input').fill('')
  })

  test('transcript: overflow-y auto, and auto-scroll-to-bottom behavior on new real messages (proof, not assumption)', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Reply with a numbered list from 1 to 80, one short line per number (e.g. "1. one"), and nothing else.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const transcript = page.getByTestId('transcript')
    await expect(transcript).toBeVisible({ timeout: 15_000 })

    // 15-conversation-scrollbar-outer-edge: `.chat-body-row` (the flex row
    // containing the transcript column AND the Tracker Rail) is now the
    // single scrolling container, so its native scrollbar sits at the
    // window's true outer-right edge, past the rail — `.transcript` itself
    // no longer scrolls independently. Assert against `.chat-body-row`, not
    // `[data-testid="transcript"]`.
    const scrollContainer = page.locator('.chat-body-row')
    await expect(scrollContainer).toBeVisible()

    // Wait for the long real reply to land, forcing real overflow.
    await expect
      .poll(
        async () => scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight * 2),
        { timeout: 30_000 }
      )
      .toBe(true)

    const bodyRowOverflowY = await computedOverflowY(page, '.chat-body-row')
    expect(bodyRowOverflowY, '.chat-body-row should have overflow-y auto (the new single scroll container)').toMatch(/auto|scroll/)

    const transcriptOverflowY = await computedOverflowY(page, '[data-testid="transcript"]')
    expect(
      transcriptOverflowY,
      '.transcript itself should no longer be an auto/scroll container — .chat-body-row owns scrolling now'
    ).not.toMatch(/^(auto|scroll)$/)

    const scrollToEnd = page.getByTestId('chat-scroll-to-end')
    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight * 2 + 1
    })
    await expect(scrollToEnd).toHaveCount(0)
    await scrollContainer.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(scrollToEnd).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'chat-scroll-to-end-visible.png') })
    await scrollToEnd.click()
    await expect
      .poll(async () =>
        scrollContainer.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop
        )
      )
      .toBeLessThanOrEqual(4)
    await expect(scrollToEnd).toHaveCount(0)

    const lastReviewableMessage = page
      .locator('.msg-wrap')
      .filter({ has: page.getByTestId('msg-review-button') })
      .last()
    await lastReviewableMessage.hover()
    await lastReviewableMessage.getByTestId('msg-review-button').click({ force: true })
    await expect(page.getByTestId('response-review-pane')).toBeVisible()
    const reviewChatScroller = page.locator('.chat-main-col')
    await expect
      .poll(() =>
        reviewChatScroller.evaluate((el) => el.scrollHeight > el.clientHeight * 2)
      )
      .toBe(true)
    await reviewChatScroller.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(scrollToEnd).toBeVisible()
    await expect(scrollToEnd).toHaveClass(/chat-scroll-to-end--review/)
    await scrollToEnd.click()
    await expect
      .poll(() =>
        reviewChatScroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop
        )
      )
      .toBeLessThanOrEqual(4)
    await expect(scrollToEnd).toHaveCount(0)
    await page.getByTestId('response-review-close').click()

    // Send one more short real message and observe whether the transcript
    // follows it to the bottom WITHOUT any manual scroll — this is the "real
    // scroll experience" claim from the task brief, verified rather than
    // assumed. `scrollTop`/`scrollHeight` are now read off `.chat-body-row`.
    const beforeScrollTop = await scrollContainer.evaluate((el) => el.scrollTop)
    await page.getByTestId('composer-input').fill('Thanks — now just reply with exactly: DONE.')
    await page.getByTestId('send-button').click()
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            document.querySelectorAll('[data-testid="transcript-message"][data-role="assistant"]')[
              document.querySelectorAll('[data-testid="transcript-message"][data-role="assistant"]').length - 1
            ]?.textContent?.includes('DONE')
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await page.waitForTimeout(300)

    const afterAppend = await scrollContainer.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }))
    const distanceFromBottom = afterAppend.scrollHeight - afterAppend.clientHeight - afterAppend.scrollTop
    // eslint-disable-next-line no-console
    console.log(
      'SCROLL-AUDIT[transcript-auto-scroll]',
      JSON.stringify({ beforeScrollTop, afterAppend, distanceFromBottomPx: distanceFromBottom })
    )
    await page.screenshot({ path: join(artifactsDir, 'scroll-audit-transcript-after-new-message.png') })

    // This assertion documents the ACTUAL behavior rather than assuming it
    // works: if ChatTranscript.tsx's auto-scroll effect weren't wired to the
    // new scroll container, this would fail, and the console log above
    // carries the exact pixel distance from the bottom the view was left at.
    expect(
      distanceFromBottom,
      `.chat-body-row should auto-follow to the bottom on new messages; it was left ${distanceFromBottom}px above the bottom instead`
    ).toBeLessThanOrEqual(4)
  })

  // ── 15-conversation-scrollbar-outer-edge: sticky Tracker Rail ────────────
  test('tracker rail: stays pinned/visible via position:sticky while the transcript scrolls past it, and has no scrollbar of its own', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    // A dedicated fresh session (not a continuation of the earlier
    // transcript test's session) so this test's task-tool calls aren't
    // affected by whatever conversation state/model that other session
    // accumulated — same session-creation pattern as chat-surface-core's
    // own passing task-tracker test.
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use TaskCreate to create exactly eight tasks with subjects "Todo 1" through "Todo 8", then use TaskUpdate ' +
        'with the returned task ID to mark "Todo 1" in_progress. Do not use any other tools. Then reply with a one-sentence summary.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const todoCard = page.getByTestId('todo-tracker-card')
    await expect(todoCard).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('todo-item')).toHaveCount(8, { timeout: 30_000 })

    const trackerRail = page.locator('.tracker-rail')
    await expect(trackerRail).toBeVisible()

    // (a) The rail itself must NOT have its own edge-of-column scrollbar —
    // `.chat-body-row` is the one and only scrolling container now.
    const railOverflowY = await computedOverflowY(page, '.tracker-rail')
    expect(railOverflowY, '.tracker-rail should not be an auto/scroll container by design').not.toMatch(/^(auto|scroll)$/)
    const railMetrics = await trackerRail.evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }))
    expect(
      railMetrics.scrollHeight,
      `.tracker-rail should not have accumulated its own internal scrollbar (scrollHeight ${railMetrics.scrollHeight} vs clientHeight ${railMetrics.clientHeight})`
    ).toBeLessThanOrEqual(railMetrics.clientHeight + 2)

    // (b) ...while the per-card `.tracker-body` (the Todos card, with 8 real
    // items) still scrolls internally, unchanged.
    const todoBody = page.locator('[data-testid="todo-tracker-card"] .tracker-body')
    const todoBodyMetrics = await todoBody.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
    // eslint-disable-next-line no-console
    console.log('SCROLL-AUDIT[tracker-body]', JSON.stringify(todoBodyMetrics))
    expect(todoBodyMetrics.scrollHeight, '.tracker-body with 8 todos should overflow its 220px max-height').toBeGreaterThan(
      todoBodyMetrics.clientHeight
    )
    const todoBodyOverflowY = await computedOverflowY(page, '[data-testid="todo-tracker-card"] .tracker-body')
    expect(todoBodyOverflowY, '.tracker-body should keep its own overflow-y auto (unchanged)').toMatch(/auto|scroll/)

    // (c) Force enough real transcript content to make `.chat-body-row`
    // overflow well past the rail's own height, then scroll it down and
    // assert the rail is STILL on screen (proving position: sticky; top: 0
    // actually pins it, rather than it just happening to be short enough to
    // never need pinning).
    await page.getByTestId('composer-input').fill(
      'Reply with a numbered list from 1 to 60, one short line per number (e.g. "1. one"), and nothing else.'
    )
    await page.getByTestId('send-button').click()

    const scrollContainer = page.locator('.chat-body-row')
    await expect
      .poll(
        async () => {
          const [bodyRow, rail] = await Promise.all([
            scrollContainer.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })),
            trackerRail.evaluate((el) => el.clientHeight)
          ])
          return bodyRow.scrollHeight > bodyRow.clientHeight + rail
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    const railRectBeforeScroll = await trackerRail.evaluate((el) => el.getBoundingClientRect().toJSON())

    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(200)

    const railRectAfterScroll = await trackerRail.evaluate((el) => el.getBoundingClientRect().toJSON())
    const viewportHeight = await page.evaluate(() => window.innerHeight)

    // eslint-disable-next-line no-console
    console.log(
      'SCROLL-AUDIT[tracker-rail-sticky]',
      JSON.stringify({ railRectBeforeScroll, railRectAfterScroll, viewportHeight })
    )

    expect(railRectAfterScroll.top, 'sticky tracker rail should still be within the viewport after scrolling the transcript').toBeGreaterThanOrEqual(0)
    expect(
      railRectAfterScroll.top,
      'sticky tracker rail should still be within the viewport after scrolling the transcript'
    ).toBeLessThan(viewportHeight)
    expect(railRectAfterScroll.height, 'sticky tracker rail should still render at (roughly) its normal height, not be clipped to nothing').toBeGreaterThan(
      50
    )

    // Close the Daily Notes side panel (open since `beforeAll` seeded a real
    // vault for the other tests in this file) so the screenshot shows the
    // chat area at its full width — the clearest demonstration of the
    // scrollbar sitting at the window's true outer-right edge, past the
    // Tracker Rail, rather than squeezed by an unrelated side panel.
    const dailyNotesClose = page.getByTestId('daily-notes-close')
    if (await dailyNotesClose.isVisible().catch(() => false)) {
      await dailyNotesClose.click()
      await page.waitForTimeout(150)
    }
    await page.screenshot({ path: join(artifactsDir, '15-conversation-scrollbar-outer-edge.png') })
  })
})
