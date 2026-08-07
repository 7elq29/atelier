import { homedir } from 'node:os'
import { REMOTE_SESSION_HOME } from '../../shared/project-path-autocomplete'

export function homeDirForWorktreeHost(hostId: string): string {
  return hostId === 'local' ? homedir() : REMOTE_SESSION_HOME
}
