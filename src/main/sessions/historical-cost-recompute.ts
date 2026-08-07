/**
 * fix-session-cost-historical-backfill: one-time recomputation of already-
 * corrupted `sessions.total_cost_usd` values from the SDK's own on-disk
 * JSONL transcript, instead of leaving the DB's compounded (wrong) figure in
 * place or discarding it to an unexplained 0.
 *
 * Background: `fix-session-cost-total-overcounted` fixed `SessionManager` to
 * stop additively summing the SDK's cumulative `result.total_cost_usd` every
 * turn, but that fix isn't retroactive — sessions that already compounded
 * before it landed are stuck with an inflated `total_cost_usd` forever
 * unless something recomputes it.
 *
 * The DB has no durable record of the true historical figure (see db.ts's
 * `0006_historical_cost_recompute_from_jsonl` doc comment for the full
 * investigation), but the `claude` CLI/SDK itself writes a JSONL transcript
 * for every session at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * — keyed by the EXACT same session id Atelier stores as `sessions.id`
 * (see `ClaudeAgentSdkHarness.launch`, which passes `sessionId`/`resume`
 * through to the SDK unchanged) — and that transcript's `assistant` entries
 * each carry a raw `usage` block untouched by Atelier's own cost bug. That
 * lets us independently recompute the real historical cost from known
 * per-model token rates, the same way Morpheus's history scanner and
 * `session-cost-tracking.spec.ts` already do for going-forward proof.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { logger } from '../logger'

const MIGRATION_NAME = '0006_historical_cost_recompute_from_jsonl'

interface ModelRates {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/**
 * Anthropic per-million-token USD rates, keyed by model-id prefix (longest
 * match wins). Mirrors the rate table Morpheus (`packages/shared/src/cost.ts`)
 * and `session-cost-tracking.spec.ts` already use and cross-check for real
 * against the SDK's own reported cost.
 */
const MODEL_RATES_PER_MTOK: Record<string, ModelRates> = {
  'claude-opus-4': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-3': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-3': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-haiku-3': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  'claude-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 }
}
const DEFAULT_RATES_PER_MTOK: ModelRates = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
const RATE_KEYS = Object.keys(MODEL_RATES_PER_MTOK).sort((a, b) => b.length - a.length)

function getModelRates(model: string | undefined | null): ModelRates {
  if (model) {
    for (const key of RATE_KEYS) {
      if (model.startsWith(key)) return MODEL_RATES_PER_MTOK[key]!
    }
  }
  return DEFAULT_RATES_PER_MTOK
}

interface TokenBucket {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
}

/**
 * Recomputes the total USD cost of a JSONL transcript from its `assistant`
 * entries' raw `usage`, bucketed per model (so Opus/Sonnet/Haiku turns each
 * price correctly).
 *
 * Claude Code emits MULTIPLE streaming `assistant` JSONL lines per real API
 * call, each carrying the SAME cumulative `usage` for that call (verified
 * for real against the corrupted session's own transcript: consecutive
 * `assistant` lines repeat identical token counts 2-3x before the next
 * non-assistant entry). Naively summing every `assistant` line's usage would
 * therefore over-count by that same multiple — so usage is buffered per run
 * of consecutive `assistant` lines and only committed to the running total
 * when a non-assistant entry (or end of file) closes that run out.
 */
export function computeCostFromJsonl(content: string): number {
  const totals = new Map<string, TokenBucket>()
  let pending: { model: string; usage: RawUsage } | null = null

  const commit = (p: { model: string; usage: RawUsage } | null): void => {
    if (!p) return
    let bucket = totals.get(p.model)
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
      totals.set(p.model, bucket)
    }
    bucket.input += p.usage.input_tokens ?? 0
    bucket.output += p.usage.output_tokens ?? 0
    const cc = p.usage.cache_creation
    const cacheWrite = cc ? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0) : 0
    bucket.cacheWrite += cacheWrite || (p.usage.cache_creation_input_tokens ?? 0)
    bucket.cacheRead += p.usage.cache_read_input_tokens ?? 0
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let entry: { type?: string; message?: { model?: string; usage?: RawUsage } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue // Malformed/truncated line (e.g. a crash mid-write) — skip, don't abort the whole recompute.
    }
    if (entry.type !== 'assistant' && pending) {
      commit(pending)
      pending = null
    }
    if (entry.type === 'assistant' && entry.message?.usage) {
      pending = { model: entry.message.model ?? '', usage: entry.message.usage }
    }
  }
  commit(pending)

  let total = 0
  for (const [model, bucket] of totals) {
    const rates = getModelRates(model)
    total +=
      (bucket.input * rates.input +
        bucket.output * rates.output +
        bucket.cacheWrite * rates.cacheWrite +
        bucket.cacheRead * rates.cacheRead) /
      1_000_000
  }
  return total
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Claude Code's own project-dir encoding: the absolute cwd with every `/` and `.` replaced by `-`. */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-')
}

export function localJsonlPath(projectPath: string, sessionId: string): string {
  const abs = expandTilde(projectPath)
  return join(homedir(), '.claude', 'projects', encodeProjectDir(abs), `${sessionId}.jsonl`)
}

/**
 * Reads a session's JSONL transcript, locally or (for a remote/devpod
 * session, keyed by `hostname` = the SSH host — see `manager.ts`'s
 * `createSession`) over the same kind of SSH connection the harness itself
 * already uses for that session. Returns `null` if the transcript can't be
 * found or read (deleted, host unreachable, timed out, etc.) — callers treat
 * that as "unrecoverable," not as an error to propagate.
 */
export function readTranscript(session: { id: string; projectPath: string; hostname: string | null }): string | null {
  if (!session.hostname) {
    const path = localJsonlPath(session.projectPath, session.id)
    if (!existsSync(path)) return null
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  }

  // Remote: the encoded project dir depends on the REMOTE $HOME, which we
  // don't know locally — so the tilde-expansion and `/`/`.` encoding both
  // happen in a small remote shell one-liner instead of here. `2>/dev/null`
  // plus a bounded timeout means "not found"/"unreachable" both just yield
  // empty output rather than hanging or throwing.
  const remoteScript =
    'proj="$1"; case "$proj" in "~"*) proj="$HOME${proj#\\~}";; esac; ' +
    'enc=$(printf "%s" "$proj" | sed "s/[\\/.]/-/g"); ' +
    'cat "$HOME/.claude/projects/$enc/$2.jsonl" 2>/dev/null'
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', session.hostname, '--', 'sh', '-c', remoteScript, '_', session.projectPath, session.id],
    { encoding: 'utf-8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 }
  )
  if (result.status !== 0 || !result.stdout) return null
  return result.stdout
}

export interface BackfillResult {
  recomputed: number
  resetToZero: number
}

/**
 * One-time backfill (gated on `migrations`, same table `runMigrations` uses,
 * under the marker name `0006_historical_cost_recompute_from_jsonl` — see
 * that migration's doc comment in `db.ts` for why this isn't inline SQL):
 * for every session with a nonzero `total_cost_usd`, try to recompute its
 * true historical cost from its JSONL transcript; if none can be found,
 * reset to 0 rather than leave the compounded-wrong figure in place.
 */
export function runHistoricalCostBackfill(database: Database.Database): BackfillResult {
  const already = database.prepare('SELECT 1 FROM migrations WHERE name = ?').get(MIGRATION_NAME)
  if (already) return { recomputed: 0, resetToZero: 0 }

  const sessions = database
    .prepare('SELECT id, project_path, hostname, total_cost_usd FROM sessions WHERE total_cost_usd != 0')
    .all() as Array<{ id: string; project_path: string; hostname: string | null; total_cost_usd: number }>

  const update = database.prepare('UPDATE sessions SET total_cost_usd = ? WHERE id = ?')
  let recomputed = 0
  let resetToZero = 0

  for (const session of sessions) {
    let transcript: string | null = null
    try {
      transcript = readTranscript({ id: session.id, projectPath: session.project_path, hostname: session.hostname })
    } catch (err) {
      logger.warn('historical cost backfill: failed reading transcript', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    if (transcript) {
      const newTotal = computeCostFromJsonl(transcript)
      update.run(newTotal, session.id)
      recomputed++
      logger.info('historical cost recomputed from JSONL transcript', {
        sessionId: session.id,
        oldTotalCostUsd: session.total_cost_usd,
        newTotalCostUsd: newTotal
      })
    } else {
      update.run(0, session.id)
      resetToZero++
      logger.info('historical cost transcript not found; reset to 0', {
        sessionId: session.id,
        oldTotalCostUsd: session.total_cost_usd
      })
    }
  }

  database.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION_NAME, new Date().toISOString())
  logger.info('historical cost backfill complete', { recomputed, resetToZero })
  return { recomputed, resetToZero }
}
