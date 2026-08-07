/** Case-insensitive substring match (empty query matches all). */
export function fileQuickOpenSubstringMatch(query: string, text: string): boolean {
  if (!query) return true
  return text.toLowerCase().includes(query.toLowerCase())
}

/** Search-mode filter: substring on file name, path relative to Dir, or absolute path. */
export function fileQuickOpenSearchMatch(
  nameFilter: string,
  fileName: string,
  relFromListDir: string,
  absolutePath?: string
): boolean {
  const q = nameFilter.trim()
  if (!q) return true
  return (
    fileQuickOpenSubstringMatch(q, fileName) ||
    fileQuickOpenSubstringMatch(q, relFromListDir) ||
    (absolutePath != null && fileQuickOpenSubstringMatch(q, absolutePath))
  )
}
