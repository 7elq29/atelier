import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'

/** Select text inside a transcript inline-comment host and trigger the selection toolbar. */
export async function selectTranscriptCommentText(host: Locator, text: string): Promise<void> {
  const content = host.getByTestId('transcript-comment-content')
  await content.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node) {
      const value = node.textContent ?? ''
      const index = value.indexOf(target)
      if (index >= 0) {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + target.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return
      }
      node = walker.nextNode() as Text | null
    }
    throw new Error(`Transcript comment text not found: ${target}`)
  }, text)
  await expect(host.getByTestId('response-review-selection-ui')).toBeVisible()
}

/** Open the comment form for the current transcript text selection. */
export async function commentOnTranscriptSelection(host: Locator, body: string): Promise<void> {
  await host.getByTestId('response-review-comment-btn').click()
  const input = host.getByTestId('response-review-comment-input')
  await input.fill(body)
  await input.press('Enter')
  await expect(host.getByTestId('response-review-comment-icon').first()).toBeVisible()
}

/** Select text inside the review pane content and trigger the selection toolbar. */
export async function selectReviewPaneText(reviewPane: Locator, text: string): Promise<void> {
  const content = reviewPane.getByTestId('response-review-content')
  await content.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node) {
      const value = node.textContent ?? ''
      const index = value.indexOf(target)
      if (index >= 0) {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + target.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return
      }
      node = walker.nextNode() as Text | null
    }
    throw new Error(`Review pane text not found: ${target}`)
  }, text)
  await expect(reviewPane.getByTestId('response-review-selection-ui')).toBeVisible()
}

/** Open the comment form for the current review-pane text selection. */
export async function commentOnReviewSelection(reviewPane: Locator, body: string): Promise<void> {
  await reviewPane.getByTestId('response-review-comment-btn').click()
  const input = reviewPane.getByTestId('response-review-comment-input')
  await input.fill(body)
  await input.press('Enter')
  await expect(reviewPane.getByTestId('response-review-comment-icon').first()).toBeVisible()
}

/** Open the popover for the first saved review comment. */
export async function openReviewCommentPopover(reviewPane: Locator): Promise<void> {
  await reviewPane.getByTestId('response-review-comment-icon').first().click()
  await expect(reviewPane.getByTestId('response-review-comment-popover')).toBeVisible()
}
export async function reconnectClosedSessionFromHistory(page: Page, sessionId: string): Promise<void> {
  const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
  await historyRow.hover()
  await historyRow.getByTestId('resume-button').click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
}

/** Default Claude model for every e2e userData profile — fast/cheap vs production Sonnet 5. */
export const E2E_DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5'

/** Default effort for e2e — lower latency/cost than production High. */
export const E2E_DEFAULT_CLAUDE_EFFORT = 'low' as const

export function e2eConfigPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

/** Session row menus portal to document.body — menu items are page-scoped, not row-scoped. */
export function sessionMenuItem(page: Page, itemTestId: string): Locator {
  return page.getByTestId(itemTestId)
}

/** Pre-seeds config.json before launching Electron (onboarding dismissed + e2e default model). */
export function seedE2eConfig(userDataDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(
    e2eConfigPath(userDataDir),
    JSON.stringify({
      onboardingCompleted: true,
      defaultClaudeModel: E2E_DEFAULT_CLAUDE_MODEL,
      defaultClaudeEffort: E2E_DEFAULT_CLAUDE_EFFORT,
      ...extra
    })
  )
}

/** @deprecated Prefer `seedE2eConfig` — kept so existing specs need minimal import renames. */
export function seedSkipOnboarding(userDataDir: string): void {
  seedE2eConfig(userDataDir)
}
