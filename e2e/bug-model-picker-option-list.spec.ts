import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction / evidence-gathering for "fix-model-picker-option-list".
 *
 * Root cause claim under investigation: `Composer.tsx`'s `MODEL_OPTIONS`
 * (lines ~20-24) is a hardcoded 3-entry array (`claude-opus-4-8`,
 * `claude-sonnet-5`, `claude-haiku-4-5`).
 *
 * GROUND TRUTH gathered directly from the installed SDK package (no
 * guessing):
 *
 *   grep -o 'id:"claude-[a-z0-9.-]*",family:"[a-z]*"' \
 *     node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
 *
 * returned the full model catalog bundled in
 * `@anthropic-ai/claude-agent-sdk@0.3.212`'s `sdk.mjs`:
 *
 *   haiku:  claude-3-5-haiku ("Haiku 3.5"), claude-haiku-4-5 ("Haiku 4.5")
 *   sonnet: claude-3-5-sonnet, claude-3-7-sonnet, claude-sonnet-4-0,
 *           claude-sonnet-4-5, claude-sonnet-4-6, claude-sonnet-5 ("Sonnet 5")
 *   opus:   claude-opus-4-0, claude-opus-4-1, claude-opus-4-5, claude-opus-4-6,
 *           claude-opus-4-7, claude-opus-4-8 ("Opus 4.8")
 *   fable:  claude-fable-5 ("Fable 5")
 *   mythos: claude-mythos-5 ("Mythos 5")
 *
 * and separately: `haiku:{default:"claude-haiku-4-5"},
 * fable:{default:"claude-fable-5"}` plus `best:"fable"` — i.e. the SDK's own
 * catalog considers "fable" (not "opus") its top/"best" family.
 *
 * So: the code comment's claim that `claude-opus-4-8` / `claude-sonnet-5` /
 * `claude-haiku-4-5` are real, resolvable model ids is CORRECT and each one
 * is in fact the latest release in its family. The actual bug is narrower
 * than "stale ids": the picker's list is a hardcoded snapshot with no
 * mechanism to track the catalog going forward, and it silently omits two
 * entire model families the SDK already exposes (`fable`, `mythos`) —
 * including the family the SDK itself flags as "best". The SDK exposes a
 * `list_models` control request (`SDKControlListModelsRequest`, sdk.d.ts
 * ~3433) specifically so a host doesn't have to hardcode this list, and
 * Composer.tsx does not call it anywhere (grepped: zero references to
 * `list_models`/`ModelInfo`/`modelCatalog` outside the SDK's own type defs).
 *
 * I could not check Uber's internal "aifx" UI's own model list from this
 * sandboxed environment (no network access to Uber-internal services) — if
 * aifx exposes a different/curated subset, that would need to be reconciled
 * separately; this spec only speaks to what the installed OSS SDK reports.
 *
 * This spec is evidence-gathering, not red/green: it captures the picker's
 * CURRENT rendered list (screenshot) and asserts today's actual (passing)
 * behavior, so a future fix that adds catalog-driven fable/mythos options
 * is a deliberate, visible diff against this baseline.
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

test.describe('bug-repro: model picker option list is a hardcoded 3-model snapshot, omits fable/mythos families', () => {
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

  test('capture the picker\'s current option list', async ({}, testInfo) => {
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

    // Current (documented-broken) state: exactly the 3 hardcoded ids, never
    // fable or mythos even though the installed SDK's catalog reports them.
    expect(modelOptionIds.sort()).toEqual(
      ['model-option-claude-opus-4-8', 'model-option-claude-sonnet-5', 'model-option-claude-haiku-4-5'].sort()
    )
    expect(modelOptionIds).not.toContain('model-option-claude-fable-5')
    expect(modelOptionIds).not.toContain('model-option-claude-mythos-5')
  })
})
