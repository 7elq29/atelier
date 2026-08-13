/**
 * Shared types for the Obsidian daily-note integration. Imported by both the
 * main process (parser/serializer, IPC handlers) and the renderer (React
 * UI), so this file must stay free of any Node/Electron/DOM imports.
 */

export type TaskStatus = 'open' | 'done' | 'forwarded' | 'in-progress' | 'cancelled'

/** Which panel section a task renders in. */
export type TaskSection = 'day-plan' | 'unscheduled' | 'tracker'

export interface ExternalLink {
  label: string
  url: string
}

export interface DailyTask {
  /**
   * Stable identity for this task, equal to `gid`. Persists across
   * re-parses of the file (including the app's own echoed writes and
   * external edits), unlike a line-number-derived id — this is the fix for
   * the "deleted task resurrects" bug: see daily-note-io.ts and
   * daily-notes-handlers.ts.
   */
  id: string
  /** The raw UUID minted for this task, embedded inline as `[gid:: <uuid>]`. */
  gid: string
  text: string
  status: TaskStatus
  section: TaskSection
  tags: string[]
  scheduled?: string
  completion?: string
  due?: string
  /** e.g. "09:30-10:00" */
  timeBlock?: string
  externalLinks: ExternalLink[]
  delegatedTo?: string
  isTracker: boolean
  /** A plain bullet (no checkbox) — a note/time-block rather than a todo. */
  isNote: boolean
  /** Atelier session id stored as `[session:: …]` in the vault task line. */
  linkedSessionId?: string
  /** Dataview-style `[priority:: …]` (e.g. high, medium, low). */
  priority?: string
}

/** Non-task markdown this note contains, preserved verbatim for round-tripping. */
export interface RawSections {
  frontmatter: string[]
  /** Everything between frontmatter and the Tasks header (e.g. Big Three). */
  beforeTasks: string[]
  /** Everything after the Backlog/Delegated subsections and before Trackers. */
  afterTasks: string[]
}

export interface DailyNote {
  date: string
  dayOfWeek: string
  tasks: DailyTask[]
  bigThree: string[]
}

export interface ReadDailyNoteResult {
  note: DailyNote | null
  raw: RawSections | null
  exists: boolean
}

/** Incomplete timeline/unscheduled tasks from the most recent prior daily note. */
export interface DailyNoteCarrySuggestionsResult {
  sourceDate: string | null
  tasks: DailyTask[]
}

/** Renderer-facing result for the Notes-section-only editor (## Notes → EOF). */
export interface DailyNoteNotesSliceResult {
  exists: boolean
  /** Markdown body under the Notes heading (heading line itself excluded). */
  notesBody: string
  /** Exact `## … Notes` heading line from the vault file (emoji preserved). */
  notesSectionHeading: string
  /** Vault-relative path to the daily note file. */
  vaultRelativePath: string
  /** True when this call created the note from the vault template. */
  created: boolean
}

/** Payload for saving a clipboard/dropped image beside a daily note. */
export interface DailyNotePasteImagePayload {
  mimeType: string
  /** Raw base64 bytes (no `data:` prefix). */
  data: string
}

/** Result of saving a pasted image into the daily note's folder. */
export interface DailyNotePasteImageResult {
  /** Obsidian wiki embed, e.g. `![[Pasted image 20260811104500.png]]`. */
  embedMarkdown: string
  fileName: string
  vaultRelativePath: string
}
