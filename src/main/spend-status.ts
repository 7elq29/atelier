/**
 * Org-wide AI harness-pool spend indicator — ported from Morpheus's
 * `cost-spend-status.ts` (origin/main, commit f09a4b18 "Replace session
 * cost tracking with spendstatus (#87)"). Same endpoint, same `usso` auth
 * flow, same defensive response parsing; adapted to Atelier's plain
 * directly-instantiated module style instead of Morpheus's DI container.
 *
 * Every failure here (missing `usso`, offline network, non-200 response)
 * is caught by the caller and logged — this must never crash the app or
 * surface an error dialog, only make the sidebar chip disappear.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import type { HarnessSpendBreakdown, SpendStatus } from '../shared/spend-status-types'

const UBER_EMAIL_SUFFIX = '@uber.com'
const USSO_CANDIDATES = ['/opt/uber/bin/usso', '/opt/homebrew/bin/usso', '/usr/local/bin/usso']
const SPEND_STATUS_BASE_URL = 'https://genai-api.uberinternal.com/v1/spendstatus/harness-pool'
const SPEND_STATUS_TIMEOUT_MS = 15_000

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

/** Locates the `usso` binary, falling back to a bare PATH lookup. */
function findUsso(): string {
  for (const candidate of USSO_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return 'usso'
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

async function getGenAiToken(forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken.raw

  const args = ['-fetch', 'genai-api', '-print']
  if (forceRefresh) args.push('-force')

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(findUsso(), args, { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) reject(err)
      else resolve(out)
    })
  })

  const token = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()

  if (!token) throw new Error('usso returned an empty genai-api token')
  cachedToken = { raw: token, cachedAt: Date.now() }
  return token
}

async function fetchSpendStatus(email: string, forceRefresh = false): Promise<Response> {
  const token = await getGenAiToken(forceRefresh)
  return fetch(`${SPEND_STATUS_BASE_URL}/${encodeURIComponent(email)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(SPEND_STATUS_TIMEOUT_MS)
  })
}

/**
 * Fetches the current user's org-wide harness-pool spend status. Throws on
 * any failure (missing `usso`, offline, non-200) — callers must catch and
 * degrade gracefully (see `spend-status-ipc.ts`).
 */
export async function getSpendStatus(): Promise<SpendStatus> {
  if (process.env.ATELIER_DISABLE_SPEND_STATUS === '1') {
    throw new Error('Spend status is disabled for this process')
  }

  const email = getCurrentUberEmail()
  let response = await fetchSpendStatus(email)
  if (response.status === 401) {
    cachedToken = undefined
    response = await fetchSpendStatus(email, true)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`spendstatus exited ${response.status}: ${body.slice(0, 200)}`)
  }

  return parseSpendStatusResponse(await response.json(), email)
}
