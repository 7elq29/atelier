import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fix verification for "fix-model-picker-option-list" (bug #53).
 *
 * Root cause: `Composer.tsx`'s `MODEL_OPTIONS` (lines ~20-70) was a
 * hardcoded 3-entry array (`claude-opus-4-8`, `claude-sonnet-5`,
 * `claude-haiku-4-5`).
 *
 * GROUND TRUTH re-verified directly from the installed SDK package's own
 * hand-maintained model catalog (`node_modules/@anthropic-ai/
 * claude-agent-sdk/sdk.mjs`'s `models`/`aliases`/`latest_per_family`/`best`
 * object — its own inline comment: "Hand-maintained baked-in model catalog
 * — the source of truth for per-model provider IDs and metadata"):
 *
 *   opus:   ...claude-opus-4-6, claude-opus-4-7, claude-opus-4-8 ("Opus 4.8")
 *           `aliases.opus.default` = `latest_per_family.opus` = claude-opus-4-8
 *   sonnet: ...claude-sonnet-4-6, claude-sonnet-5 ("Sonnet 5", context
 *           window already `1e6`/native_1m — NOT a 200k model with a 1M
 *           toggle, unlike several older ones in the same catalog)
 *           `aliases.sonnet.default` = `latest_per_family.sonnet` = claude-sonnet-5
 *   haiku:  claude-3-5-haiku, claude-haiku-4-5 ("Haiku 4.5")
 *           `aliases.haiku.default` = `latest_per_family.haiku` = claude-haiku-4-5
 *   fable:  claude-fable-5 ("Fable 5") — `aliases.fable.default` =
 *           `latest_per_family.fable` = claude-fable-5, AND the catalog's own
 *           top-level `best: "fable"` flag (i.e. the SDK's own opinion of
 *           its single best model overall is fable, not opus)
 *   mythos: claude-mythos-5 ("Mythos 5") — present in `models[]` with a real
 *           1M-native context block, but absent from `aliases`/
 *           `latest_per_family` (no short alias) — still a real id, just an
 *           un-aliased one.
 *
 * There is NO "claude-opus-5" id anywhere in the catalog (grepped the whole
 * file for it — zero matches) — an earlier unverified aifx `/model`
 * screenshot mentioned one, but it does not correspond to anything the
 * installed SDK actually reports, so it was NOT added; ground truth here is
 * the SDK's own catalog, not that screenshot.
 *
 * Fix: `MODEL_OPTIONS` now lists the `latest_per_family` id for every family
 * the catalog reports (opus/sonnet/haiku/fable) PLUS `mythos`, the one
 * un-aliased-but-real family — i.e. exactly the two families
 * (`fable`/`mythos`) this spec's original (pre-fix) baseline proved were
 * missing. Older generations already superseded within a represented family
 * (claude-opus-4-0/-4-1/-4-5/-4-6/-4-7, claude-sonnet-4-0/-4-5/-4-6,
 * claude-3-5-haiku, claude-3-5-sonnet, claude-3-7-sonnet) are deliberately
 * left out — see `MODEL_OPTIONS`'s doc comment in Composer.tsx.
 *
 * I could not check Uber's internal "aifx" UI's own model list from this
 * sandboxed environment (no network access to Uber-internal services) — if
 * aifx exposes a different/curated subset, that would need to be reconciled
 * separately; this spec only speaks to what the installed OSS SDK reports,
 * which is verifiable and is what `HarnessStartOptions.model` (main/harness/
 * types.ts) actually passes straight through to the SDK's own `query()`.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
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

test.describe('bug-fix: model picker now surfaces the full verified catalog (fable/mythos included, no stale/invented ids)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-model-list-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-model-list-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('picker lists exactly the verified real catalog: opus-4-8, sonnet-5, haiku-4-5, fable-5, mythos-5', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.locator('[data-testid="session-row"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })

    await page.getByTestId('model-picker-button').click()
    const popover = page.getByTestId('model-picker-popover')
    await expect(popover).toBeVisible()

    const modelOptionIds = await popover
      .locator('[data-testid^="model-option-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))

    await page.screenshot({ path: join(artifactsDir, 'fix-model-picker-option-list.png') })

    // Fixed state: the full verified 5-model catalog, fable/mythos included.
    expect(modelOptionIds.sort()).toEqual(
      [
        'model-option-claude-opus-4-8',
        'model-option-claude-sonnet-5',
        'model-option-claude-haiku-4-5',
        'model-option-claude-fable-5',
        'model-option-claude-mythos-5'
      ].sort()
    )
    // No invented id anywhere in the catalog (the unverified aifx screenshot's
    // "Opus 5" claim) and no stale/legacy generation snuck in either.
    expect(modelOptionIds).not.toContain('model-option-claude-opus-5')
    expect(modelOptionIds).not.toContain('model-option-claude-opus-4-6')
    expect(modelOptionIds).not.toContain('model-option-claude-sonnet-4-6')
  })
})
