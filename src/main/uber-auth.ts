/**
 * Uber-internal auth bootstrap for GUI-launched Atelier.
 *
 * Claude Code's apiKeyHelper runs `usso -ussh genai-api -print`, which needs a
 * uSSH cert and/or cached uSSO offline token. Terminal-launched dev inherits
 * interactive login; Dock-launched apps do not — so we provision auth on
 * demand before local harness/ssh spawns (same as running ussh/usso manually).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { logger } from './logger'
import { subprocessEnvWithDevPath } from './shell-path'

const execFileAsync = promisify(execFile)

const GENAI_API = 'genai-api'
export const USSO_CANDIDATES = ['/opt/uber/bin/usso', '/opt/homebrew/bin/usso', '/usr/local/bin/usso']
const USSH_CANDIDATES = ['/opt/uber/bin/ussh', '/usr/local/bin/ussh', '/opt/homebrew/bin/ussh']

const PATH_EXPORT =
  'export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/uber/bin:$HOME/.local/bin:$HOME/.local/share/aifx/bin:$PATH"'

function findBinary(candidates: readonly string[], fallback: string): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return fallback
}

export function findUsso(): string {
  return findBinary(USSO_CANDIDATES, 'usso')
}

function findUssh(): string {
  return findBinary(USSH_CANDIDATES, 'ussh')
}

function uberAuthBootstrapDisabled(): boolean {
  if (process.env.ATELIER_DISABLE_UBER_AUTH_BOOTSTRAP === '1') return true
  return process.argv.some((arg) => arg.includes('atelier-e2e'))
}

function apiKeyHelperPath(): string {
  const fallback = join(homedir(), '.local/share/aifx/bin/claude-genai-token-helper')
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf-8')) as {
      apiKeyHelper?: unknown
    }
    return typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.length > 0
      ? settings.apiKeyHelper
      : fallback
  } catch {
    return fallback
  }
}

function extractJwt(stdout: string): string | null {
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('eyJ')) return trimmed
  }
  return null
}

type ProbeResult = { ok: true } | { ok: false; detail: string; needsInteractive: boolean }

async function probeGenAiToken(): Promise<ProbeResult> {
  const env = subprocessEnvWithDevPath()
  const helper = apiKeyHelperPath()

  if (existsSync(helper)) {
    try {
      const { stdout, stderr } = await execFileAsync(helper, [], {
        env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      })
      if (extractJwt(stdout)) return { ok: true }
      const detail = (stderr || stdout).trim() || 'apiKeyHelper returned an empty token'
      return { ok: false, detail, needsInteractive: /no ssh cert|ussh|login|authenticate/i.test(detail) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, detail, needsInteractive: /no ssh cert|ussh|login|authenticate|empty/i.test(detail) }
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(findUsso(), ['-ussh', GENAI_API, '-print'], {
      env,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
    if (extractJwt(stdout)) return { ok: true }
    const detail = stderr.trim() || 'usso returned an empty genai-api token'
    return { ok: false, detail, needsInteractive: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, detail, needsInteractive: true }
  }
}

function shouldUseTerminalForInteractiveAuth(): boolean {
  return process.platform === 'darwin' && !process.stdin.isTTY
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function openTerminalScript(scriptPath: string): Promise<void> {
  const escaped = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await execFileAsync(
    'osascript',
    [
      '-e',
      'tell application "Terminal"',
      '-e',
      'activate',
      '-e',
      `do script "${escaped}"`,
      '-e',
      'end tell',
    ],
    { timeout: 30_000 },
  )
}

async function pollUntil(timeoutMs: number, intervalMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(intervalMs)
  }
  return false
}

function authBanner(title: string): string {
  return `echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Atelier — ${title}"
echo "  Complete the login below, then return to Atelier."
echo "════════════════════════════════════════════════════════════"
echo ""`
}

async function runInteractiveAuthBootstrap(): Promise<void> {
  const usso = findUsso()
  const ussh = findUssh()
  const scriptBody = `#!/bin/zsh
${PATH_EXPORT}
${authBanner('Uber authentication required')}
if ${JSON.stringify(usso)} -ussh ${GENAI_API} -print 2>/dev/null | grep -q '^eyJ'; then
  echo "Already authenticated."
else
  if ! ${JSON.stringify(ussh)} -ussh-quiet 2>/dev/null; then
    ${JSON.stringify(ussh)}
  fi
  if ! ${JSON.stringify(usso)} -ussh ${GENAI_API} -print 2>/dev/null | grep -q '^eyJ'; then
    echo ""
    echo "Fetching genai-api token (browser login may open)..."
    ${JSON.stringify(usso)} -fetch ${GENAI_API} -print
  fi
fi
echo ""
echo "Atelier: Uber authentication finished. You can close this window."
`
  const dir = mkdtempSync(join(tmpdir(), 'atelier-uber-auth-'))
  const scriptPath = join(dir, 'bootstrap.sh')
  writeFileSync(scriptPath, scriptBody, 'utf-8')
  chmodSync(scriptPath, 0o755)

  if (shouldUseTerminalForInteractiveAuth()) {
    logger.info('uber-auth: opening Terminal for interactive usso/ussh login')
    await openTerminalScript(scriptPath)
    const ready = await pollUntil(600_000, 2_000, async () => (await probeGenAiToken()).ok)
    if (!ready) {
      throw new Error('Uber authentication timed out. Run `ussh` in Terminal, then retry.')
    }
    return
  }

  logger.info('uber-auth: running interactive usso/ussh bootstrap in subprocess')
  await execFileAsync('/bin/zsh', [scriptPath], {
    env: subprocessEnvWithDevPath(),
    timeout: 600_000,
    maxBuffer: 1024 * 1024,
  })
}

let genAiEnsurePromise: Promise<void> | undefined
/** Set once `ussh -ussh-quiet` succeeds or interactive bootstrap completes. */
let usshCertReady = false
/** Dedupes concurrent ensureUssh() — quiet probe and bootstrap share one flight. */
let usshEnsureInFlight: Promise<void> | undefined

async function probeUsshQuiet(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(findUssh(), ['-ussh-quiet'], { env, timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

async function runUsshInteractiveBootstrap(env: NodeJS.ProcessEnv): Promise<void> {
  logger.info('uber-auth: ussh cert missing, provisioning')
  if (shouldUseTerminalForInteractiveAuth()) {
    const ussh = findUssh()
    const scriptBody = `#!/bin/zsh
${PATH_EXPORT}
${authBanner('uSSH login required for devpod sessions')}
${JSON.stringify(ussh)}
echo ""
echo "Atelier: ussh finished. You can close this window."
`
    const dir = mkdtempSync(join(tmpdir(), 'atelier-uber-auth-'))
    const scriptPath = join(dir, 'ussh.sh')
    writeFileSync(scriptPath, scriptBody, 'utf-8')
    chmodSync(scriptPath, 0o755)
    await openTerminalScript(scriptPath)
    const ready = await pollUntil(600_000, 2_000, () => probeUsshQuiet(env))
    if (!ready) {
      throw new Error('uSSH login timed out. Run `ussh` in Terminal, then retry.')
    }
  } else {
    await execFileAsync(findUssh(), [], { env, timeout: 120_000 })
  }
  logger.info('uber-auth: ussh cert ready')
}

/**
 * Ensures genai-api credentials exist for Claude Code's apiKeyHelper.
 * Opens Terminal on macOS GUI launches when browser/uSSH login is required.
 */
export async function ensureGenAiAuth(): Promise<void> {
  if (uberAuthBootstrapDisabled()) return

  const initial = await probeGenAiToken()
  if (initial.ok) return

  if (!genAiEnsurePromise) {
    genAiEnsurePromise = (async () => {
      logger.info('uber-auth: genai-api token missing, provisioning auth', { detail: initial.detail })
      await runInteractiveAuthBootstrap()
      const after = await probeGenAiToken()
      if (!after.ok) {
        throw new Error(
          after.detail ||
            'Uber authentication failed. Run `ussh` in Terminal, then retry.',
        )
      }
      logger.info('uber-auth: genai-api auth ready')
    })().finally(() => {
      genAiEnsurePromise = undefined
    })
  }

  return genAiEnsurePromise
}

/**
 * Ensures a local uSSH cert exists before ssh/devpod spawns (ssh, remote terminals).
 * Successful `-ussh-quiet` is cached for the process lifetime; concurrent callers
 * share one in-flight probe/bootstrap instead of spawning ussh per call.
 */
export async function ensureUssh(): Promise<void> {
  if (uberAuthBootstrapDisabled()) return
  if (usshCertReady) return

  if (!usshEnsureInFlight) {
    usshEnsureInFlight = (async () => {
      const env = subprocessEnvWithDevPath()
      try {
        await execFileAsync(findUssh(), ['-ussh-quiet'], { env, timeout: 30_000 })
        usshCertReady = true
        return
      } catch {
        // fall through to interactive bootstrap
      }
      await runUsshInteractiveBootstrap(env)
      usshCertReady = true
    })().finally(() => {
      usshEnsureInFlight = undefined
    })
  }

  return usshEnsureInFlight
}

/** True when running as a packaged macOS app launched without a terminal (Dock). */
export function isPackagedGuiLaunch(): boolean {
  return app.isPackaged && shouldUseTerminalForInteractiveAuth()
}
