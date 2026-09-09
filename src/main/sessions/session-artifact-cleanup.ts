import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import type { SessionRecord } from '../../shared/session-types'
import { shQuote } from '../shell-quote'
import { sshExec } from '../ssh-exec'

/**
 * Remove Claude Code's files for one exact session id. The SDK may have run
 * from the project root or an Atelier worktree, so scan every encoded cwd
 * directory rather than trying to reconstruct one path from current state.
 */
export async function removeClaudeSessionFiles(
  session: Pick<SessionRecord, 'id' | 'hostname'>
): Promise<void> {
  if (session.hostname) {
    const fileName = shQuote(`${session.id}.jsonl`)
    const directoryName = shQuote(session.id)
    const command =
      `rm -rf -- "$HOME/.claude/session-env"/${directoryName}; ` +
      'root="$HOME/.claude/projects"; ' +
      '[ ! -d "$root" ] || ' +
      `find "$root" -mindepth 2 -maxdepth 2 \\( \\( -type f -name ${fileName} \\) -o \\( -type d -name ${directoryName} \\) \\) ` +
      '-exec rm -rf -- {} +'
    const result = await sshExec(session.hostname, command)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `remote session-file cleanup exited ${result.code}`)
    }
    return
  }

  const projectsRoot = join(homedir(), '.claude', 'projects')
  const removals: Array<Promise<void>> = [
    rm(join(homedir(), '.claude', 'session-env', session.id), { recursive: true, force: true })
  ]
  try {
    const projects = await readdir(projectsRoot, { withFileTypes: true })
    for (const entry of projects) {
      if (!entry.isDirectory()) continue
      const projectDirectory = join(projectsRoot, entry.name)
      removals.push(
        rm(join(projectDirectory, `${session.id}.jsonl`), { force: true }),
        rm(join(projectDirectory, session.id), { recursive: true, force: true })
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await Promise.all(removals)
}
