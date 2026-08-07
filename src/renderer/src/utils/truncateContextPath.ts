/** Shorten an absolute path for UI chrome (`~` + last two segments). */
export function truncateContextPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null
  const shortened = absPath.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
  const parts = shortened.split('/').filter(Boolean)
  if (parts.length === 0) return shortened
  if (parts.length <= 2) {
    if (parts[0] === '~') {
      return parts.length === 1 ? '~' : `~/${parts.slice(1).join('/')}`
    }
    return shortened.startsWith('/') ? shortened : `/${parts.join('/')}`
  }
  const tail = parts.slice(-2).join('/')
  return `…/${tail}`
}
