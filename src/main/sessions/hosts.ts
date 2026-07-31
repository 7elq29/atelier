import type { RemoteHostOption } from '../../shared/session-types'
import type { RemoteHostResolver } from './manager'

/**
 * Static remote host list for 02-session-lifecycle. Real target verified
 * running via `devpod ps`: qingqin-go.devpod-us-or. A future task can make
 * this dynamic (shell out to `devpod list`/`devpod ps`); hardcoding here
 * keeps this task's scope to "the harness's SSH path actually works",
 * per spec.md.
 */
const STATIC_HOSTS: RemoteHostOption[] = [
  {
    id: 'devpod-us-or',
    sshHost: 'qingqin-go.devpod-us-or',
    label: 'devpod-us-or',
    status: 'running',
    // Confirmed via `ssh qingqin-go.devpod-us-or -- 'ls -la ~/.local/bin'`:
    // aifx symlinks the real claude install here, but non-interactive SSH
    // commands don't get ~/.local/bin on PATH (bare `claude` -> exit 127),
    // while the full path works identically to an interactive shell.
    remoteExecutablePath: '/home/user/.local/bin/claude'
  }
]

export function createStaticHostResolver(): RemoteHostResolver {
  return {
    list: () => STATIC_HOSTS,
    resolve: (hostId: string) => STATIC_HOSTS.find((h) => h.id === hostId),
    resolveByHostname: (sshHost: string) => STATIC_HOSTS.find((h) => h.sshHost === sshHost)
  }
}
