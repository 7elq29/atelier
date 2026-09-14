/**
 * Rewrites opaque Claude Code / SDK harness errors into transcript copy.
 * Used when persisting a system error and when rendering one (so rows that
 * already stored the raw SDK string still read clearly).
 */

export const CLAUDE_CODE_EXIT_255_NOTICE =
  'Claude Code stopped unexpectedly. Send a message to retry.'

const EXIT_255 = /claude code process exited with code 255/i
const EXIT_OTHER = /claude code process exited with code (\d+)/i

export function formatHarnessErrorForUser(raw: string): string {
  const text = raw.replace(/^Error:\s*/i, '').trim()
  if (EXIT_255.test(text)) return CLAUDE_CODE_EXIT_255_NOTICE
  const other = text.match(EXIT_OTHER)
  if (other) {
    return `Claude Code stopped unexpectedly (exit ${other[1]}). Send a message to retry.`
  }
  return text
}

/** System-role transcript body: keep the `Error:` prefix, rewrite the rest. */
export function formatSystemTranscriptError(content: string): string {
  const hadErrorPrefix = /^Error:\s*/i.test(content)
  const friendly = formatHarnessErrorForUser(content)
  if (!hadErrorPrefix) return friendly
  if (/^Error:\s*/i.test(friendly)) return friendly
  return `Error: ${friendly}`
}
