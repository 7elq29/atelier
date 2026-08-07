/** Strip common ANSI/OSC sequences so prompt and command parsing sees plain text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '')
}

/**
 * Parse `ssh …` command lines typed in a local shell to infer the remote host
 * for sidebar labeling. Returns null when the line is not a simple ssh invocation.
 */
export function parseSshHostFromShellLine(line: string): string | null {
  const trimmed = stripAnsi(line).trim()
  const sshIdx = trimmed.search(/\bssh(?:\s|$)/)
  if (sshIdx < 0) return null
  const rest = trimmed.slice(sshIdx).replace(/^ssh\s+/, '')
  if (!rest) return null
  const tokens = rest.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i]
    const takesArg = new Set(['-o', '-b', '-c', '-i', '-F', '-J', '-l', '-p', '-t', '-W', '-w'])
    if (takesArg.has(opt) && i + 1 < tokens.length) i += 2
    else i += 1
  }
  const target = tokens[i]
  if (!target) return null
  const at = target.lastIndexOf('@')
  return at >= 0 ? target.slice(at + 1) : target
}

/**
 * Extract the hostname from a shell prompt line like `user@host ~ %` or `user@host:$`.
 * Returns null when the line does not look like a prompt.
 */
export function parsePromptHostFromLine(line: string): string | null {
  const trimmed = stripAnsi(line).trim()
  if (!trimmed || /^[%$#>]$/.test(trimmed)) return null

  // Devpod / custom zsh: `user@alias(full.host.name) ~`
  const parenHost = trimmed.match(/@[\w.-]+\(([\w.-]+)\)/)
  if (parenHost) return parenHost[1]

  // Classic single-line prompt: `user@host ~ %` or `user@host:$`
  const sameLine = trimmed.match(/([\w.-]+)@([\w.-]+)(?:\s|:|\[)?(?:[^\n[%$#>]*)?\s*[%$#>]\s*$/)
  if (sameLine) return sameLine[2]

  // Prompt path line without trailing sigil (zsh puts `%` on the next line): `user@host ~`
  const tildePrompt = trimmed.match(/^([\w.-]+)@([\w.-]+)(?:\([^)]+\))?\s+~(?:\s|$)/)
  if (tildePrompt) return tildePrompt[2]

  return null
}

/** Match OpenSSH "Connection to … closed." banners when leaving an SSH session. */
export function parseSshConnectionClosed(data: string): boolean {
  return /Connection to .+ closed\.?/i.test(stripAnsi(data))
}

/** Hostnames that should display as sidebar "Local" (this machine). */
export function localMachineHostLabels(machineHostname: string): string[] {
  const full = machineHostname.trim()
  const short = full.split('.')[0] ?? full
  return [...new Set([full, short].filter(Boolean))]
}

export function isLocalMachineHost(host: string, localLabels: readonly string[]): boolean {
  const h = host.trim().toLowerCase()
  return localLabels.some((l) => l.toLowerCase() === h)
}

function hostFromPromptLine(line: string): string | null {
  return parsePromptHostFromLine(line)
}

/**
 * Scan recent terminal output for the latest shell prompt and infer remote vs local host.
 * Returns `undefined` when no prompt-like line is found (do not change sidebar state).
 */
export function inferShellHostFromPtyTail(
  outputTail: string,
  localLabels: readonly string[]
): string | null | undefined {
  const stripped = stripAnsi(outputTail)
  const lines = stripped.split(/\r?\n/)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 16); i--) {
    const line = lines[i]?.trim() ?? ''
    let host = hostFromPromptLine(line)
    // zsh themes that put `%` / `$` on its own line below the path
    if (!host && /^[%$#>]$/.test(line) && i > 0) {
      host = hostFromPromptLine(lines[i - 1] ?? '')
    }
    if (!host) continue
    if (isLocalMachineHost(host, localLabels)) return null
    return host
  }
  return undefined
}
