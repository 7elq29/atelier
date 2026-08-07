import { normalize, resolve } from 'node:path'

/**
 * Best-effort cwd after a Bash `command` string (handles `cd`, `&&`, `;`, `||`).
 * Used only to keep the composer context bar in sync when Claude cds mid-turn.
 */
export function applyBashCdCommands(cwd: string, command: string): string {
  let next = cwd
  for (const segment of command.split(/(?:&&|\|\||;|\n)/)) {
    const part = segment.trim()
    const match = part.match(/^cd(?:\s+(.+?))?(?:\s|$)/)
    if (!match) continue
    const arg = match[1]?.trim()
    if (arg === undefined || arg === '') continue
    if (arg === '-') continue
    if (arg.startsWith('/')) next = normalize(arg)
    else if (arg.startsWith('~')) next = arg
    else next = normalize(resolve(next, arg))
  }
  return next
}
