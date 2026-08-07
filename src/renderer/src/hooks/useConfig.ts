import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_CONFIG, type AtelierConfig } from '../../../shared/config'

/**
 * Loads the persisted config over IPC on mount and exposes an `updateConfig`
 * that optimistically applies a partial update locally, then persists it via
 * `window.atelier.setConfig` and reconciles with whatever main returns.
 */
export function useConfig(): {
  config: AtelierConfig
  loaded: boolean
  updateConfig: (partial: Partial<AtelierConfig>) => void
} {
  const [config, setConfig] = useState<AtelierConfig>(DEFAULT_CONFIG)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.atelier.getConfig().then((loadedConfig) => {
      if (cancelled) return
      setConfig(loadedConfig)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const updateConfig = useCallback((partial: Partial<AtelierConfig>) => {
    setConfig((prev) => ({
      ...prev,
      ...partial,
      fontSizes: { ...prev.fontSizes, ...(partial.fontSizes ?? {}) },
      gitIdentity: { ...prev.gitIdentity, ...(partial.gitIdentity ?? {}) },
      vault: { ...prev.vault, ...(partial.vault ?? {}) }
    }))
    window.atelier.setConfig(partial).then(setConfig)
  }, [])

  return { config, loaded, updateConfig }
}
