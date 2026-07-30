import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_CONFIG, type GardeniaConfig } from '../../../shared/config'

/**
 * Loads the persisted config over IPC on mount and exposes an `updateConfig`
 * that optimistically applies a partial update locally, then persists it via
 * `window.gardenia.setConfig` and reconciles with whatever main returns.
 */
export function useConfig(): {
  config: GardeniaConfig
  loaded: boolean
  updateConfig: (partial: Partial<GardeniaConfig>) => void
} {
  const [config, setConfig] = useState<GardeniaConfig>(DEFAULT_CONFIG)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.gardenia.getConfig().then((loadedConfig) => {
      if (cancelled) return
      setConfig(loadedConfig)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const updateConfig = useCallback((partial: Partial<GardeniaConfig>) => {
    setConfig((prev) => ({
      ...prev,
      ...partial,
      fontSizes: { ...prev.fontSizes, ...(partial.fontSizes ?? {}) },
      gitIdentity: { ...prev.gitIdentity, ...(partial.gitIdentity ?? {}) }
    }))
    window.gardenia.setConfig(partial).then(setConfig)
  }, [])

  return { config, loaded, updateConfig }
}
