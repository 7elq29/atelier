import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'

/**
 * Electron packs dependencies in `app.asar`. The SDK resolves the bundled
 * `claude` path inside that archive; `existsSync` succeeds but `spawn()` cannot
 * exec through ASAR. Real binaries live under `app.asar.unpacked` (same pattern
 * as `scripts/patch-node-pty.js` for spawn-helper).
 */
export function rewriteNativePathOutOfAsar(filePath: string): string {
  if (!filePath.includes('app.asar')) return filePath
  if (filePath.includes('app.asar.unpacked')) {
    return filePath.replace(/app\.asar\.unpacked\.unpacked/g, 'app.asar.unpacked')
  }
  return filePath
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked')
}

/** Platform optional package shipped with `@anthropic-ai/claude-agent-sdk`. */
function claudeNativePackageName(): string {
  const base = '@anthropic-ai/claude-agent-sdk'
  const { platform, arch } = process
  if (platform === 'linux') return `${base}-linux-${arch}`
  if (platform === 'win32') return `${base}-win32-${arch}`
  if (platform === 'darwin') return `${base}-darwin-${arch}`
  return `${base}-${platform}-${arch}`
}

function claudeExeName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/**
 * Absolute path to the bundled Claude Code CLI for this OS/arch, with ASAR
 * rewrite when packaged. Returns undefined if the optional native package is
 * missing (SDK will throw its own error).
 */
export function resolveClaudeCodeExecutable(): string | undefined {
  const pkg = claudeNativePackageName()
  const exe = claudeExeName()
  const candidates: string[] = []

  if (app.isPackaged) {
    // Don't use createRequire here — plain resolution walks app.asar and returns
    // a path spawn() can't exec. The unpacked copy is always beside app.asar.
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, exe))
  }

  // Dev: repo-root node_modules (out/main → ../../node_modules).
  candidates.push(join(__dirname, '..', '..', 'node_modules', pkg, exe))

  try {
    const req = createRequire(join(__dirname, 'index.js'))
    candidates.push(req.resolve(`${pkg}/${exe}`))
  } catch {
    /* optional native package absent on this platform */
  }

  for (const candidate of candidates) {
    const path = rewriteNativePathOutOfAsar(candidate)
    if (path.includes('/app.asar/') || path.includes('\\app.asar\\')) continue
    if (existsSync(path)) {
      logger.info('resolved claude code executable', { path })
      return path
    }
  }

  logger.error('claude code executable not found', { pkg, candidates: candidates.map(rewriteNativePathOutOfAsar) })
  return undefined
}
