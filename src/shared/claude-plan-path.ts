/** Whether a repo-relative path is a Claude Code plan file (written by the SDK agent). */
export function isClaudePlanPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized.includes('.claude/plans/')
}
