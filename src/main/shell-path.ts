import { homedir } from 'node:os'
import { join } from 'node:path'

/** Paths commonly on login-shell PATH but missing from macOS GUI-launched apps. */
const DEV_TOOL_PATH_PREFIXES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/uber/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), '.local/share/aifx/bin'),
]

/**
 * macOS GUI apps inherit a minimal PATH (`/usr/bin:/bin:...`) without Homebrew
 * or `~/.local/bin`. Claude Code hooks and auth helpers (e.g. `aifx`) live
 * there, so harness turns fail with hook exit 127 when launched from Dock.
 * Call once at startup so every subprocess inherits a usable PATH.
 */
export function augmentProcessPathForGuiLaunch(): void {
  const current = process.env.PATH ?? ''
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [...DEV_TOOL_PATH_PREFIXES, ...current.split(':')]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  process.env.PATH = parts.join(':')
}

/** Same PATH merge as {@link augmentProcessPathForGuiLaunch}, for explicit `env` overrides. */
export function subprocessEnvWithDevPath(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const current = base.PATH ?? process.env.PATH ?? ''
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [...DEV_TOOL_PATH_PREFIXES, ...current.split(':')]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  return { ...base, PATH: parts.join(':') } as Record<string, string>
}
