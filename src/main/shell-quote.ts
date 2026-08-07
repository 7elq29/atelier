/**
 * POSIX shell quoting helpers shared by every code path that builds a remote
 * command string to run over `ssh <host> -- <command>` (the harness's remote
 * spawn and the git panel's remote git invocations) — args built locally as
 * an argv array must be re-quoted here for the destination's login shell,
 * unlike a local `spawn(cmd, args[])`, which never goes through a shell.
 */

/** Single-quotes a value for safe interpolation into a POSIX shell command string. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Escapes a value for safe interpolation inside a *double-quoted* POSIX
 * shell string (as opposed to `shQuote`, which produces a single-quoted
 * string). Double quotes still allow the shell to expand `$`, `` ` ``, and
 * `\`, so those (plus the closing `"` itself) must be backslash-escaped.
 * Single quotes need no escaping inside double quotes.
 */
export function shDoubleQuoteEscape(value: string): string {
  return value.replace(/[\\"$`]/g, '\\$&')
}

/**
 * Builds the `cd` target for a remote command.
 *
 * `shQuote` (single-quoting) is correct for arbitrary path bytes, but it
 * also disables the remote shell's own `~` expansion — `cd '~'` fails with
 * "no such file or directory: ~" because a single-quoted `~` is never
 * tilde-expanded by POSIX shells. Since Atelier's project-path field is free
 * text (see NewSessionModal's `project-path` input), a user typing the
 * a user typing the completely natural `~` or `~/projects/foo` would break
 * remote session creation entirely.
 *
 * Fix: special-case paths starting with `~` and build them with `$HOME`
 * (double-quoted, so the *remote* shell expands it) instead of relying on
 * the shell's own tilde-parsing. Everything else keeps using the existing
 * single-quoted `shQuote` path unchanged.
 */
export function remoteCdTarget(cwd: string): string {
  if (cwd === '~') {
    return '"$HOME"'
  }
  if (cwd.startsWith('~/')) {
    const rest = cwd.slice(2)
    return `"$HOME/${shDoubleQuoteEscape(rest)}"`
  }
  return shQuote(cwd)
}
