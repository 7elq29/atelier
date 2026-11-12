/**
 * Org-wide AI harness-pool spend indicator — ported from Morpheus's
 * `cost-spend-status.ts` (origin/main, commit f09a4b18 "Replace session
 * cost tracking with spendstatus (#87)"). Same endpoint, same `usso` auth
 * flow, same defensive response parsing; adapted to Atelier's plain
 * directly-instantiated module style instead of Morpheus's DI container.
 *
 * Auth: prefer quiet `usso -ussh genai-api -print` (no browser). Interactive
 * `usso -fetch` may open a browser login — spend polls allow that **once**
 * per process; further polls stay quiet until the user clicks Renew USSO.
 *
 * Every non-auth failure (missing `usso`, offline network, non-200) degrades
 * to `unavailable` — never crash the app or surface an error dialog.
 */
import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { shell } from 'electron'
import * as pty from 'node-pty'
import type {
  HarnessSpendBreakdown,
  SpendStatus,
  SpendStatusSnapshot
} from '../shared/spend-status-types'
import { logger } from './logger'
import { findUsso } from './uber-auth'
import { subprocessEnvWithDevPath } from './shell-path'

const execFileAsync = promisify(execFile)

const UBER_EMAIL_SUFFIX = '@uber.com'
const SPEND_STATUS_BASE_URL = 'https://genai-api.uberinternal.com/v1/spendstatus/harness-pool'
const SPEND_STATUS_TIMEOUT_MS = 15_000
const GENAI_API = 'genai-api'
/** Printed by `usso -fetch` when it cannot open a browser itself (no TTY). */
export const USSO_WEBLOGIN_URL = 'https://usso.uberinternal.com/oidauth/weblogin'

type PlainObject = Record<string, unknown>

const SPENT_KEYS = [
  'spent',
  'spend',
  'spendusd',
  'amountspent',
  'currentspend',
  'current',
  'used',
  'usage',
  'usageusd',
  'totalspend',
  'totalspent',
  'total'
]

const CAP_KEYS = [
  'cap',
  'limit',
  'budget',
  'quota',
  'capusd',
  'limitusd',
  'budgetusd',
  'spendcap',
  'spendingcap',
  'hardcap',
  'softcap'
]

const HARNESS_KEYS = ['harness', 'harnessid', 'name', 'id', 'pool', 'provider', 'type']

const BREAKDOWN_KEYS = [
  'harnesses',
  'harnessspend',
  'harnessbreakdown',
  'breakdown',
  'byharness',
  'usagebyharness',
  'spendbyharness',
  'tools',
  'pools'
]

/** Derives the current user's LDAP from $USER/os.userInfo(), stripping a trailing @uber.com if present. */
function getCurrentLdap(): string {
  const rawUser = process.env.USER || userInfo().username
  const trimmed = rawUser.trim()
  const ldap = trimmed.endsWith(UBER_EMAIL_SUFFIX) ? trimmed.slice(0, -UBER_EMAIL_SUFFIX.length) : trimmed

  if (!/^[A-Za-z0-9._-]+$/.test(ldap)) {
    throw new Error(`Invalid current user LDAP: ${rawUser}`)
  }
  return ldap
}

function getCurrentUberEmail(): string {
  return `${getCurrentLdap()}${UBER_EMAIL_SUFFIX}`
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[$,\s]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function getValueByKeys(source: PlainObject, keys: string[]): unknown {
  const wanted = new Set(keys)
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(normalizeKey(key))) return value
  }
  return undefined
}

function getNumberByKeys(source: PlainObject, keys: string[]): number | null {
  return parseMoney(getValueByKeys(source, keys))
}

function getStringByKeys(source: PlainObject, keys: string[]): string | null {
  const value = getValueByKeys(source, keys)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function unwrapPayload(raw: unknown): unknown {
  let current = raw
  for (let i = 0; i < 3; i++) {
    if (!isObject(current)) return current
    const next = current.data ?? current.result ?? current.payload ?? current.spendStatus ?? current.spend_status
    if (!next || next === current) return current
    current = next
  }
  return current
}

function parseHarnessEntry(nameHint: string | null, value: unknown): HarnessSpendBreakdown | null {
  if (typeof value === 'number' || typeof value === 'string') {
    const spent = parseMoney(value)
    if (!nameHint || spent == null) return null
    return { harness: nameHint, spent }
  }
  if (!isObject(value)) return null

  const harness = getStringByKeys(value, HARNESS_KEYS) ?? nameHint
  const spent = getNumberByKeys(value, SPENT_KEYS)
  if (!harness || spent == null) return null
  return {
    harness,
    spent,
    cap: getNumberByKeys(value, CAP_KEYS)
  }
}

function parseHarnessBreakdown(payload: PlainObject): HarnessSpendBreakdown[] {
  const breakdownValue = getValueByKeys(payload, BREAKDOWN_KEYS)
  const entries: HarnessSpendBreakdown[] = []

  if (Array.isArray(breakdownValue)) {
    for (const item of breakdownValue) {
      const parsed = parseHarnessEntry(null, item)
      if (parsed) entries.push(parsed)
    }
  } else if (isObject(breakdownValue)) {
    for (const [key, value] of Object.entries(breakdownValue)) {
      const parsed = parseHarnessEntry(key, value)
      if (parsed) entries.push(parsed)
    }
  }

  return entries.sort((a, b) => b.spent - a.spent)
}

export function parseSpendStatusResponse(raw: unknown, email: string): SpendStatus {
  const payload = unwrapPayload(raw)
  if (!isObject(payload)) {
    throw new Error('spendstatus response was not an object')
  }

  const harnesses = parseHarnessBreakdown(payload)
  const spent = getNumberByKeys(payload, SPENT_KEYS) ?? harnesses.reduce((sum, item) => sum + item.spent, 0)
  const cap = getNumberByKeys(payload, CAP_KEYS)

  return {
    email,
    spent,
    cap,
    currency: 'USD',
    updatedAt: Date.now(),
    harnesses
  }
}

let cachedToken: { raw: string; cachedAt: number } | undefined
/** Spend poll may open the browser login at most once until manual renew succeeds. */
let autoInteractiveFetchAttempted = false
/** Counts interactive `-fetch` invocations (auto + manual) for e2e / logs. */
let interactiveFetchCount = 0
/** Counts shell.openExternal weblogin opens (e2e asserts Renew opens the auth page). */
let webloginOpenCount = 0
/** Auto path opens the browser at most once per process (manual renew always opens). */
let webloginOpenedForAuto = false

function extractToken(stdout: string): string | null {
  const token = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  return token && token.length > 0 ? token : null
}

function isAuthFailureMessage(detail: string): boolean {
  return /no ssh cert|ussh|usso|login|authenticate|empty|expired|unauthorized|401|403|credential/i.test(
    detail
  )
}

function extractUssoWebloginUrl(text: string): string | null {
  const match = text.match(/https:\/\/usso\.uberinternal\.com\/oidauth\/weblogin\S*/i)
  return match?.[0] ?? null
}

/** GUI / e2e: do not launch a real browser (still count for tests). */
function spendStatusBrowserOpensDisabled(): boolean {
  if (process.env.ATELIER_SPEND_STATUS_FIXTURE) return true
  if (process.env.ATELIER_DISABLE_SPEND_STATUS === '1') return true
  return process.argv.some((arg) => arg.includes('atelier-e2e'))
}

/**
 * Dock-launched Atelier has no TTY — `usso -fetch` prints the weblogin URL then
 * dies with `open /dev/tty`. Open that URL ourselves so Renew / first auto
 * fetch actually show the auth page.
 */
async function openUssoWebloginBrowser(
  reason: 'auto' | 'manual',
  detail = ''
): Promise<void> {
  if (reason === 'auto' && webloginOpenedForAuto) return
  const url = extractUssoWebloginUrl(detail) ?? USSO_WEBLOGIN_URL
  webloginOpenCount += 1
  if (reason === 'auto') webloginOpenedForAuto = true

  if (spendStatusBrowserOpensDisabled()) {
    logger.info('spend-status: weblogin open (skipped in e2e/fixture)', {
      reason,
      url,
      webloginOpenCount
    })
    return
  }

  try {
    await shell.openExternal(url)
    logger.info('spend-status: opened USSO weblogin in browser', { reason, url })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('spend-status: failed to open USSO weblogin', {
      reason,
      detail: msg.slice(0, 200)
    })
  }
}

function ussoNeedsExternalBrowser(detail: string): boolean {
  return (
    /oidauth\/weblogin/i.test(detail) ||
    /open \/dev\/tty/i.test(detail) ||
    /Waiting for Authentication/i.test(detail) ||
    /device not configured/i.test(detail)
  )
}

/** Quiet probe — never opens a browser. */
async function printQuietGenAiToken(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(findUsso(), ['-ussh', GENAI_API, '-print'], {
      encoding: 'utf-8',
      env: subprocessEnvWithDevPath(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
    const token = extractToken(stdout)
    if (token) return token
    const detail = stderr.trim() || 'usso quiet print returned empty'
    if (!isAuthFailureMessage(detail)) {
      logger.warn('spend-status: quiet usso print failed', { detail: detail.slice(0, 200) })
    }
    return null
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (!isAuthFailureMessage(detail)) {
      logger.warn('spend-status: quiet usso print error', { detail: detail.slice(0, 200) })
    }
    return null
  }
}

/**
 * Run `usso -fetch` on a hidden node-pty so it has a real TTY.
 * Never opens macOS Terminal.app and never shows Atelier's terminal panel —
 * the user only sees the browser weblogin page.
 */
async function fetchInteractiveGenAiTokenViaPty(opts?: { force?: boolean }): Promise<string | null> {
  const args = ['-fetch', GENAI_API, '-print']
  if (opts?.force) args.push('-force')
  const usso = findUsso()
  const env = subprocessEnvWithDevPath() as Record<string, string>

  return await new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (token: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already exited */
      }
      resolve(token)
    }

    logger.info('spend-status: interactive usso fetch via hidden pty', {
      force: !!opts?.force
    })

    let proc: pty.IPty
    try {
      proc = pty.spawn(usso, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: homedir(),
        env
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn('spend-status: pty spawn failed', { detail: detail.slice(0, 200) })
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      logger.warn('spend-status: interactive usso pty timed out')
      finish(null)
    }, 120_000)

    proc.onData((chunk) => {
      out += chunk
    })
    proc.onExit(() => {
      const token = extractToken(out)
      if (token) {
        cachedToken = { raw: token, cachedAt: Date.now() }
        finish(token)
        return
      }
      logger.warn('spend-status: interactive usso pty exited without token', {
        detail: out.replace(/\s+/g, ' ').trim().slice(0, 200)
      })
      finish(null)
    })
  })
}

/**
 * Interactive fetch.
 * `auto`: short execFile probe (no Terminal); on TTY failure open browser once.
 * `manual`: hidden PTY so usso can wait after weblogin (Renew USSO).
 */
async function fetchInteractiveGenAiToken(
  reason: 'auto' | 'manual',
  opts?: { force?: boolean }
): Promise<string | null> {
  if (reason === 'auto' && autoInteractiveFetchAttempted) {
    return null
  }
  if (reason === 'auto') autoInteractiveFetchAttempted = true

  interactiveFetchCount += 1
  logger.info('spend-status: interactive usso fetch', {
    reason,
    force: !!opts?.force,
    interactiveFetchCount,
    via: reason === 'manual' ? 'pty' : 'exec'
  })

  if (reason === 'manual') {
    return fetchInteractiveGenAiTokenViaPty(opts)
  }

  const args = ['-fetch', GENAI_API, '-print']
  if (opts?.force) args.push('-force')

  try {
    const { stdout } = await execFileAsync(findUsso(), args, {
      encoding: 'utf-8',
      env: subprocessEnvWithDevPath(),
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    })
    const token = extractToken(stdout)
    if (token) {
      cachedToken = { raw: token, cachedAt: Date.now() }
      return token
    }
    return null
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logger.warn('spend-status: interactive usso fetch failed', {
      reason,
      detail: detail.slice(0, 200)
    })
    // usso printed the login URL but could not drive a TTY — open the browser
    // once. Never open Terminal.app.
    if (ussoNeedsExternalBrowser(detail)) {
      await openUssoWebloginBrowser('auto', detail)
    }
    return null
  }
}

async function resolveGenAiToken(): Promise<'ready' | 'needs_usso' | 'unavailable'> {
  if (cachedToken) return 'ready'

  const quiet = await printQuietGenAiToken()
  if (quiet) {
    cachedToken = { raw: quiet, cachedAt: Date.now() }
    return 'ready'
  }

  const interactive = await fetchInteractiveGenAiToken('auto')
  if (interactive) return 'ready'

  // Quiet + (at most one) interactive failed — show Renew USSO, do not fetch again.
  return 'needs_usso'
}

async function fetchSpendStatus(email: string): Promise<Response> {
  if (!cachedToken) throw new Error('spend-status: no genai token')
  return fetch(`${SPEND_STATUS_BASE_URL}/${encodeURIComponent(email)}`, {
    headers: {
      Authorization: `Bearer ${cachedToken.raw}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(SPEND_STATUS_TIMEOUT_MS)
  })
}

/**
 * Named per-product spend pools (Cortana / Minion / Cursor) live beside the
 * harness-pool endpoint and share the same `{ spend_usd, cap_usd }` shape.
 * 204 / non-OK / network errors silently omit that bar.
 */
const NAMED_SPEND_POOLS: ReadonlyArray<{ harness: string; path: string }> = [
  { harness: 'Cortana', path: 'cortana' },
  { harness: 'Minion', path: 'minion' },
  { harness: 'Cursor', path: 'cursor' }
]

async function fetchNamedPoolSpend(
  email: string,
  harness: string,
  path: string
): Promise<HarnessSpendBreakdown | null> {
  try {
    if (!cachedToken) return null
    const resp = await fetch(
      `https://genai-api.uberinternal.com/v1/spendstatus/${path}/${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${cachedToken.raw}`,
          'rpc-caller': 'atelier',
          'rpc-service': 'genai-api',
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(SPEND_STATUS_TIMEOUT_MS)
      }
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    const spent = typeof data.spend_usd === 'number' ? data.spend_usd : null
    if (spent == null) return null
    return {
      harness,
      spent,
      cap: typeof data.cap_usd === 'number' ? data.cap_usd : null
    }
  } catch {
    return null
  }
}

function fixtureSnapshot(): SpendStatusSnapshot | null {
  const fixture = process.env.ATELIER_SPEND_STATUS_FIXTURE
  if (process.env.ATELIER_DISABLE_SPEND_STATUS === '1') {
    return { state: 'unavailable' }
  }
  if (fixture === 'needs_usso') {
    // Simulate expired auth without calling usso (e2e).
    if (!autoInteractiveFetchAttempted) {
      autoInteractiveFetchAttempted = true
      interactiveFetchCount += 1
      logger.info('spend-status: interactive usso fetch', {
        reason: 'auto',
        force: false,
        interactiveFetchCount,
        fixture: true
      })
    }
    return { state: 'needs_usso' }
  }
  if (fixture === 'ready') {
    return {
      state: 'ready',
      data: {
        email: getCurrentUberEmail(),
        spent: 12.34,
        cap: 2000,
        currency: 'USD',
        updatedAt: Date.now(),
        harnesses: [
          { harness: 'Cortana', spent: 3.21, cap: 1300 },
          { harness: 'Minion', spent: 1.1, cap: 3000 }
        ]
      }
    }
  }
  return null
}

/**
 * Fetches the current user's org-wide harness-pool spend status.
 * Never throws to IPC — returns a snapshot the chip can render.
 */
export async function getSpendStatusSnapshot(): Promise<SpendStatusSnapshot> {
  const fixture = fixtureSnapshot()
  if (fixture) return fixture

  try {
    const auth = await resolveGenAiToken()
    if (auth === 'unavailable') return { state: 'unavailable' }
    if (auth === 'needs_usso') return { state: 'needs_usso' }

    const email = getCurrentUberEmail()
    let response = await fetchSpendStatus(email)
    if (response.status === 401) {
      // Stale cached JWT — quiet re-print only. Do not `-force` (opens another tab).
      cachedToken = undefined
      const quiet = await printQuietGenAiToken()
      if (!quiet) {
        const again = await fetchInteractiveGenAiToken('auto')
        if (!again) return { state: 'needs_usso' }
      } else {
        cachedToken = { raw: quiet, cachedAt: Date.now() }
      }
      response = await fetchSpendStatus(email)
      if (response.status === 401) return { state: 'needs_usso' }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.warn('spend-status: harness-pool non-OK', {
        status: response.status,
        body: body.slice(0, 200)
      })
      return { state: 'unavailable' }
    }

    const [status, ...namedPools] = await Promise.all([
      parseSpendStatusResponse(await response.json(), email),
      ...NAMED_SPEND_POOLS.map((pool) => fetchNamedPoolSpend(email, pool.harness, pool.path))
    ])

    for (const entry of namedPools) {
      if (entry) status.harnesses.push(entry)
    }
    status.harnesses.sort((a, b) => b.spent - a.spent)

    return { state: 'ready', data: status }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (isAuthFailureMessage(detail)) return { state: 'needs_usso' }
    logger.warn('spend status unavailable', { error: detail.slice(0, 200) })
    return { state: 'unavailable' }
  }
}

/**
 * User clicked Renew USSO — open weblogin in the system browser, then complete
 * `usso -fetch` on a hidden internal PTY. Never opens Terminal.app / terminal UI.
 */
export async function renewSpendStatusUsso(): Promise<{
  ok: boolean
  interactiveFetchCount: number
  webloginOpenCount: number
}> {
  // Browser only for the user — auth page, not a terminal window.
  await openUssoWebloginBrowser('manual')

  if (process.env.ATELIER_SPEND_STATUS_FIXTURE === 'needs_usso') {
    interactiveFetchCount += 1
    logger.info('spend-status: interactive usso fetch', {
      reason: 'manual',
      force: true,
      interactiveFetchCount,
      fixture: true,
      via: 'fixture'
    })
    // Stay on needs_usso until fixture flips; still proves the click path.
    return { ok: false, interactiveFetchCount, webloginOpenCount }
  }
  if (process.env.ATELIER_DISABLE_SPEND_STATUS === '1') {
    return { ok: false, interactiveFetchCount, webloginOpenCount }
  }

  cachedToken = undefined
  const token = await fetchInteractiveGenAiToken('manual', { force: true })
  return { ok: !!token, interactiveFetchCount, webloginOpenCount }
}

/** E2E / diagnostics for the once-only auto browser open gate. */
export function getSpendStatusAuthDebug(): {
  interactiveFetchCount: number
  autoInteractiveFetchAttempted: boolean
  webloginOpenCount: number
} {
  return { interactiveFetchCount, autoInteractiveFetchAttempted, webloginOpenCount }
}

/** @deprecated Prefer getSpendStatusSnapshot — kept for parse unit call sites. */
export async function getSpendStatus(): Promise<SpendStatus> {
  const snap = await getSpendStatusSnapshot()
  if (snap.state !== 'ready') throw new Error(`spend status ${snap.state}`)
  return snap.data
}
