import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AtelierConfig } from '../shared/config'
import { logger } from './logger'

let cached: AtelierConfig | undefined
let configPath: string | undefined

function getConfigPath(): string {
  if (!configPath) {
    const dataDir = join(app.getPath('userData'), 'data')
    mkdirSync(dataDir, { recursive: true })
    configPath = join(dataDir, 'config.json')
  }
  return configPath
}

function mergeConfig(base: AtelierConfig, partial: Partial<AtelierConfig>): AtelierConfig {
  return {
    ...base,
    ...partial,
    fontSizes: { ...base.fontSizes, ...(partial.fontSizes ?? {}) },
    gitIdentity: { ...base.gitIdentity, ...(partial.gitIdentity ?? {}) },
    vault: { ...base.vault, ...(partial.vault ?? {}) }
  }
}

/**
 * Loads the on-disk config (a plain JSON file under `<userData>/data/config.json`),
 * falling back to defaults for anything missing/corrupt. Cached in-memory after
 * the first load per process lifetime.
 */
export function loadConfig(): AtelierConfig {
  if (cached) return cached

  const path = getConfigPath()
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AtelierConfig>
      cached = mergeConfig(DEFAULT_CONFIG, raw)
    } catch (err) {
      logger.warn('failed to parse config.json, falling back to defaults', {
        error: err instanceof Error ? err.message : String(err)
      })
      cached = { ...DEFAULT_CONFIG }
    }
  } else {
    cached = { ...DEFAULT_CONFIG }
  }
  return cached
}

export function saveConfig(partial: Partial<AtelierConfig>): AtelierConfig {
  const current = loadConfig()
  cached = mergeConfig(current, partial)
  writeFileSync(getConfigPath(), JSON.stringify(cached, null, 2))
  logger.info('config saved', { config: cached })
  return cached
}

/** Test/dev-only helper to force a reload from disk on next `loadConfig()` call. */
export function invalidateConfigCache(): void {
  cached = undefined
}
