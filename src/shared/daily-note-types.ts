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
