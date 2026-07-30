import { useEffect, useState } from 'react'

/**
 * App shell — no product UI yet (that starts in 03-chat-surface-core). This
 * proves the IPC bridge end-to-end: renderer asks main for the app version
 * and displays it in a debug corner.
 */
export default function App(): JSX.Element {
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    window.gardenia
      .getAppVersion()
      .then((version) => {
        setAppVersion(version)
        window.gardenia.log('info', 'renderer received app version via IPC', { version })
      })
      .catch((err) => {
        window.gardenia.log('error', 'failed to fetch app version via IPC', {
          error: err instanceof Error ? err.message : String(err)
        })
      })
  }, [])

  return (
    <div className="app-shell">
      <div className="app-shell__empty">
        <p>Gardenia</p>
      </div>
      <div className="app-shell__debug" data-testid="debug-corner">
        <span className="label-caps">version</span>{' '}
        <span data-testid="app-version">{appVersion ?? 'loading…'}</span>
      </div>
    </div>
  )
}
