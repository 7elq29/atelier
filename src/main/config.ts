import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AtelierConfig } from '../shared/config'
import { BUILTIN_THEMES, BUILTIN_THEME_IDS } from '../shared/theme-types'
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

/**
 * Ensures all built-in themes are present in the list, prepended before any
 * user-created themes.  Idempotent: themes whose IDs already exist are not
 * duplicated.  Existing user themes that happen to share a built-in ID (from
 * a prior manual injection) are kept as-is and not overwritten.
 */
function seedBuiltinThemes(themes: AtelierConfig['customThemes']): AtelierConfig['customThemes'] {
  const existingIds = new Set(themes.map((t) => t.id))
  const missing = BUILTIN_THEMES.filter((t) => !existingIds.has(t.id))
  if (missing.length === 0) return themes
  // Prepend built-in themes; user themes follow.
  const userThemes = themes.filter((t) => !BUILTIN_THEME_IDS.has(t.id))
  return [...missing, ...themes.filter((t) => BUILTIN_THEME_IDS.has(t.id)), ...userThemes]
}

function mergeConfig(base: AtelierConfig, partial: Partial<AtelierConfig>): AtelierConfig {
  return {
    ...base,
    ...partial,
    fontSizes: { ...base.fontSizes, ...(partial.fontSizes ?? {}) },
    gitIdentity: { ...base.gitIdentity, ...(partial.gitIdentity ?? {}) },
    vault: { ...base.vault, ...(partial.vault ?? {}) },
    terminalToolbox: partial.terminalToolbox
      ? { commands: partial.terminalToolbox.commands ?? base.terminalToolbox.commands }
      : base.terminalToolbox,
    sessionProfiles: partial.sessionProfiles ?? base.sessionProfiles,
    customThemes: seedBuiltinThemes(partial.customThemes ?? base.customThemes),
    activeCustomThemeId: 'activeCustomThemeId' in partial ? partial.activeCustomThemeId! : base.activeCustomThemeId
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
  let needsWrite = false
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AtelierConfig>
      // If any built-in themes are missing from disk, seeding will add them —
      // write back immediately so partial saves later don't drop them.
      const rawThemeIds = new Set((raw.customThemes ?? []).map((t: { id: string }) => t.id))
      needsWrite = BUILTIN_THEMES.some((t) => !rawThemeIds.has(t.id))
      cached = mergeConfig(DEFAULT_CONFIG, raw)
    } catch (err) {
      logger.warn('failed to parse config.json, falling back to defaults', {
        error: err instanceof Error ? err.message : String(err)
      })
      cached = { ...DEFAULT_CONFIG }
      needsWrite = true
    }
  } else {
    cached = { ...DEFAULT_CONFIG }
    needsWrite = true
  }
  if (needsWrite) {
    writeFileSync(path, JSON.stringify(cached, null, 2))
    logger.info('config seeded with built-in themes')
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
