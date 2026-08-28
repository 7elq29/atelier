/** Drag payload MIME for sidebar app notes (not daily/weekly vault notes). */
export const APP_NOTE_DRAG_MIME = 'application/x-atelier-app-note'

export type AppNoteDragPayload = {
  id: string
  title: string
}

export function parseAppNoteDragPayload(raw: string): AppNoteDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AppNoteDragPayload
    if (typeof parsed.id !== 'string' || typeof parsed.title !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** Relative workspace path for a materialized app note file on send. */
export function appNoteAttachRelativePath(noteId: string, title: string): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note'
  return `.atelier/app-notes/${slug}-${noteId.slice(0, 8)}.md`
}

export function formatAppNoteFileContent(note: { title: string; content: string }): string {
  const title = note.title.trim() || 'Untitled note'
  const body = note.content.trimEnd()
  if (body.startsWith('#')) return body.length > 0 ? body : `# ${title}\n`
  return body.length > 0 ? `# ${title}\n\n${body}` : `# ${title}\n`
}

export function joinToWorkspaceRoot(relativeOrAbs: string, workspaceRoot: string): string {
  const path = relativeOrAbs.trim()
  if (path.startsWith('/') || path.startsWith('~')) return path
  const root = workspaceRoot.replace(/\/$/, '')
  return `${root}/${path.replace(/^\.\//, '')}`
}
