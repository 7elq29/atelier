/**
 * Session-scoped file edit rollups for the chat changes cap — sourced from
 * completed Edit/Write/MultiEdit/NotebookEdit tool calls (not git diff).
 */

export interface SessionFileEdit {
  /** Repo-relative path within the session workspace. */
  path: string
  additions: number
  deletions: number
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function isSessionFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

/** Line stats for one completed file-edit tool call (matches ToolCallCard editSummary rules). */
export function lineStatsForFileEditTool(
  name: string,
  input: unknown
): { additions: number; deletions: number } | null {
  const obj = asRecord(input)
  switch (name) {
    case 'Edit': {
      const oldStr = obj.old_string
      const newStr = obj.new_string
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null
      return { additions: countLines(newStr), deletions: countLines(oldStr) }
    }
    case 'MultiEdit': {
      const edits = obj.edits
      if (!Array.isArray(edits) || edits.length === 0) return null
      let additions = 0
      let deletions = 0
      for (const edit of edits) {
        const e = asRecord(edit)
        if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null
        additions += countLines(e.new_string)
        deletions += countLines(e.old_string)
      }
      return { additions, deletions }
    }
    case 'Write': {
      const content = obj.content
      if (typeof content !== 'string') return null
      return { additions: countLines(content), deletions: 0 }
    }
    case 'NotebookEdit':
      return { additions: 1, deletions: 0 }
    default:
      return null
  }
}

/** File path(s) touched by a file-edit tool call (absolute or relative as in tool input). */
export function filePathsForFileEditTool(name: string, input: unknown): string[] {
  if (!isSessionFileEditTool(name)) return []
  const obj = asRecord(input)
  const filePath = obj.file_path
  if (typeof filePath === 'string' && filePath.length > 0) return [filePath]
  return []
}
