import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression coverage for fix-session-cost-historical-backfill.
 *
 * Root cause recap: `fix-session-cost-total-overcounted` stopped
 * `SessionManager` from additively summing the SDK's cumulative
 * `result.total_cost_usd` every turn, but that fix isn't retroactive —
 * sessions that already compounded before it landed are stuck with a
 * permanently inflated `sessions.total_cost_usd` forever (confirmed for
 * real against the user's own DB: session f93a2566-846d-4e89-b23b-
 * b7ca7016d493 showing $365.24 against a real cross-session total of ~$293).
 *
 * Investigation found the DB itself retains no durable historical figure —
 * `result` events only ever reach it via a bare `SessionStore.addCost`
 * UPDATE — but the SDK's own on-disk JSONL transcript for a session
 * (written by the `claude` CLI at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, keyed by the exact
 * same session id Atelier stores) DOES durably retain every turn's raw
 * `usage`, untouched by the bug. Verified for real against the actual
 * corrupted session's remote transcript: recomputing from usage (deduping
 * Claude Code's repeated streaming `assistant` JSONL lines, which share
 * IDENTICAL cumulative usage per API call) via known per-model rates gives
 * $27.13 — matching the session's own real climb "from ~$27" noted before
 * the bug compounded it.
 *
 * `runHistoricalCostBackfill` (src/main/sessions/historical-cost-recompute.ts),
 * invoked once from `openDatabase` and gated on the `migrations` table under
 * `0006_historical_cost_recompute_from_jsonl`, recomputes every
 * already-corrupted session's `total_cost_usd` from its JSONL transcript
 * where one still exists, and falls back to resetting to 0 (rather than
 * leaving a confidently-wrong number) only when no transcript can be found.
 *
 * This spec seeds BOTH outcomes against a throwaway fixture DB + fixture
 * JSONL (never touching the user's real
 * `~/Library/Application Support/atelier/data/atelier.sqlite`):
 *  1. A session whose fixture transcript exists — expect its corrupted
 *     total_cost_usd to be recomputed to the exact dollar figure its
 *     token usage implies.
 *  2. A session with a corrupted total but NO matching transcript on disk —
 *     expect it to be reset to exactly 0.
 *
 * The app's `debug:execDb`/`debug:queryDb` test-only IPC channels (same
 * pattern as `session-lifecycle.spec.ts`'s `queryDb` helper) are used to
 * seed and verify DB rows directly, since better-sqlite3's native binary
 * here is compiled against Electron's ABI and can't be `require()`d from
 * this plain-Node Playwright process.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')

function configPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string, home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: home }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

async function execDb(activePage: Page, sql: string, params: unknown[] = []): Promise<void> {
  await activePage.evaluate(({ sql: query, params: bindings }) => window.atelier.debugExecDb(query, bindings), {
    sql,
    params
  })
}

/** Claude Code's own project-dir encoding: absolute cwd with every `/`/`.` replaced by `-` (mirrors historical-cost-recompute.ts's `encodeProjectDir`). */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-')
}

/** A minimal but realistic JSONL transcript: a `user` line, then THREE streaming `assistant` lines sharing IDENTICAL cumulative usage for one API call (the real duplication pattern verified against the actual corrupted session), then a closing `user` (tool_result) line. Only the FINAL assistant usage before the transcript ends should be counted once. */
function fixtureJsonl(model: string, usage: Record<string, number>): string {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model, usage } }),
    JSON.stringify({ type: 'assistant', message: { model, usage } }),
    JSON.stringify({ type: 'assistant', message: { model, usage } })
  ]
  return lines.join('\n') + '\n'
}

test.describe('fix-session-cost-historical-backfill', () => {
  test('recomputes a corrupted total from its JSONL transcript, and resets to 0 when no transcript exists', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'atelier-e2e-home-'))
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cost-backfill-'))
    const localProjectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-project-'))
    seedSkipOnboarding(userDataDir)

    const recomputeSessionId = 'e2e-recompute-11111111-1111-1111-1111-111111111111'
    const resetSessionId = 'e2e-reset-22222222-2222-2222-2222-222222222222'

    // Fixture transcript for the "recoverable" session: 1,000,000 input
    // tokens + 200,000 output tokens on claude-sonnet-4 ($3/$15 per Mtok) =
    // exactly $3.00 + $3.00 = $6.00, chosen as a round number so the
    // recomputed total can be asserted exactly rather than approximately.
    const encodedDir = encodeProjectDir(localProjectDir)
    const transcriptDir = join(fakeHome, '.claude', 'projects', encodedDir)
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(
      join(transcriptDir, `${recomputeSessionId}.jsonl`),
      fixtureJsonl('claude-sonnet-4', {
        input_tokens: 1_000_000,
        output_tokens: 200_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      })
    )
    // Deliberately NO transcript file written for resetSessionId.

    // First launch: fresh DB, no sessions yet, so `runHistoricalCostBackfill`
    // is a no-op except recording its "already attempted" marker.
    let { app, page } = await launchApp(userDataDir, fakeHome)
    await execDb(page, 'DELETE FROM migrations WHERE name = ?', ['0006_historical_cost_recompute_from_jsonl'])

    // Seed both sessions with a corrupted total the OLD buggy way would have
    // produced: additively summing raw cumulative per-turn totals across
    // simulated turns (e.g. turn reports totalled $27, then $180, then
    // $365.24 cumulative — old code summed each RAW cumulative report on
    // top of the last, compounding well past the real spend) — the exact
    // starting number doesn't matter for this test, only that it's
    // corrupted/nonzero and gets overwritten.
    const now = new Date().toISOString()
    for (const [id, corruptedTotal] of [
      [recomputeSessionId, 365.24],
      [resetSessionId, 50]
    ] as const) {
      await execDb(
        page,
        `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order, total_cost_usd)
         VALUES (?, ?, 0, ?, 'claude-code', NULL, NULL, 0, NULL, ?, NULL, NULL, 0, ?)`,
        [id, `Fixture session ${id}`, localProjectDir, now, corruptedTotal]
      )
    }

    // Re-remove the marker (seeding may have happened after a prior
    // relaunch in a retried run) and relaunch so `openDatabase` re-runs
    // `runHistoricalCostBackfill` against the now-seeded corrupted rows —
    // this recreates the real-world "user already has old corrupted data,
    // then upgrades to the version with this fix" scenario.
    await execDb(page, 'DELETE FROM migrations WHERE name = ?', ['0006_historical_cost_recompute_from_jsonl'])
    await app.close()
    ;({ app, page } = await launchApp(userDataDir, fakeHome))

    const rows = await queryDb<{ id: string; total_cost_usd: number }>(
      page,
      'SELECT id, total_cost_usd FROM sessions WHERE id IN (?, ?)',
      [recomputeSessionId, resetSessionId]
    )
    const byId = new Map(rows.map((r) => [r.id, r.total_cost_usd]))

    expect(byId.get(recomputeSessionId)).toBeCloseTo(6.0, 6)
    expect(byId.get(resetSessionId)).toBe(0)

    const migrationRow = await queryDb<{ name: string }>(page, 'SELECT name FROM migrations WHERE name = ?', [
      '0006_historical_cost_recompute_from_jsonl'
    ])
    expect(migrationRow).toHaveLength(1)

    await app.close()
  })
})
