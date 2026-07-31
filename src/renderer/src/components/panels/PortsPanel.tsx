import { useEffect, useState } from 'react'
import type { PortForward } from '../../../../shared/panel-types'

/**
 * Ports panel (07-secondary-panels §6, remote/devpod sessions only): real
 * user-defined SSH local port forwards against the session's remote host,
 * spawned as independent `ssh -L` child processes and confirmed active via
 * a real local TCP connect (see main/panels/ports.ts).
 */
export default function PortsPanel({ sessionId, sshHost }: { sessionId: string; sshHost: string }): JSX.Element {
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('localhost')
  const [remotePort, setRemotePort] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.gardenia.portsList(sessionId).then(setForwards)
    const unsub = window.gardenia.onPortsUpdated((all) => {
      setForwards(all.filter((f) => f.sessionId === sessionId))
    })
    return unsub
  }, [sessionId])

  async function handleAdd(): Promise<void> {
    const lp = parseInt(localPort, 10)
    const rp = parseInt(remotePort, 10)
    if (!lp || !rp || !remoteHost.trim()) return
    setBusy(true)
    try {
      await window.gardenia.portsAdd(sessionId, sshHost, lp, remoteHost.trim(), rp)
      setLocalPort('')
      setRemotePort('')
      const all = await window.gardenia.portsList(sessionId)
      setForwards(all)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="ports-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {forwards.length === 0 ? (
        <div className="empty-main" style={{ height: '60%' }}>
          <div className="empty-icon">🔌</div>
          <div>No port forwards yet</div>
        </div>
      ) : (
        <div className="ports-body" data-testid="ports-list">
          {forwards.map((f) => (
            <div className="port-row" key={f.id} data-testid="port-row">
              <span className="pmain">
                localhost:{f.localPort} → {f.remoteHost}:{f.remotePort}
              </span>
              <span className={`port-state ${f.status}`} data-testid="port-status">
                {f.status}
              </span>
              <button
                className="btn btn-icon btn-sm"
                onClick={() => void window.gardenia.portsRemove(f.id)}
                data-testid="port-remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="add-port-form">
        <input placeholder="local port" value={localPort} onChange={(e) => setLocalPort(e.target.value)} data-testid="port-local-input" />
        <input placeholder="remote host" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} data-testid="port-remote-host-input" />
        <input placeholder="remote port" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} data-testid="port-remote-port-input" />
        <button className="btn btn-sm" disabled={busy} onClick={() => void handleAdd()} data-testid="port-add">
          + Add forward
        </button>
      </div>
    </div>
  )
}
