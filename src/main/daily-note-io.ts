/**
 * daily-note-io.ts — Pure-function parser/serializer for Atelier's Obsidian
 * daily-note format. No `fs`/Electron imports: all disk access is handled by
 * the caller (src/main/daily-notes-handlers.ts).
 *
 * Vault layout: `${vaultRoot}/01.dailynotes/${yyyy}/${mmm}/${ww}/${date}.md`
 *
 * Task line grammar:
 *   `- [x] 09:30–12:00 Task text #tag [scheduled:: 2026-07-23] [gid:: <uuid>] — PersonName`
 *
 * `[key:: value]` is a single generic inline-field mechanism — `gid` is not
 * special-cased in the regex, it rides the same extraction as `scheduled` /
 * `completion` / `due`. Every task is minted a `gid` the first time it's
 * parsed if it doesn't already have one; a task's `id` is always equal to
 * its `gid`. Because `gid` lives in the file content rather than being
 * derived from line position, a task's `id` is stable across re-parses even
 * when other lines are added/removed/reordered around it — this is the
 * mechanism the write-back tombstone diff (daily-notes-handlers.ts) relies
 * on to tell "externally deleted" apart from "still there, just moved".
 *
 * `parseDailyNote` itself never touches disk — it only *reports* which ids
 * it minted this call (`mintedIds`). It's the caller's job (see
 * daily-notes-handlers.ts's `persistMintedGids`) to write a freshly-minted
 * `[gid:: ...]` back to the file the first time it's encountered — a task
 * hand-typed in Obsidian (no Atelier-authored gid) would otherwise be
 * minted a brand-new random id on every independent parse, which breaks the
 * "id is stable" invariant this module's other comments rely on
 * (fix-gidless-task-id-not-persisted).
 */

import type {
  DailyNote,
  DailyTask,
  TaskStatus,
  TaskSection,
  ExternalLink,
  RawSections
} from '../shared/daily-note-types'

// ── id minting ───────────────────────────────────────────────────

/** Mint a fresh persistent task id (UUID v4 via the platform's WebCrypto). */
export function mintTaskId(): string {
  return globalThis.crypto.randomUUID()
}

/** The set of task ids (== gids) present in a note — used for tombstone diffing. */
export function getTaskIds(note: DailyNote): Set<string> {
  return new Set(note.tasks.map((t) => t.id))
}

// ── status mapping ───────────────────────────────────────────────

const STATUS_CHAR_TO_STATUS: Record<string, TaskStatus> = {
  ' ': 'open',
  x: 'done',
  '>': 'forwarded',
  '/': 'in-progress',
  '-': 'cancelled'
}

const STATUS_TO_CHAR: Record<TaskStatus, string> = {
  open: ' ',
  done: 'x',
  forwarded: '>',
  'in-progress': '/',
  cancelled: '-'
}

// ── line-level parsing ───────────────────────────────────────────

const TASK_RE = /^(\s*)- \[(.)\]\s+(.*)$/
const PLAIN_BULLET_RE = /^(\s*)-\s+(.+)$/

interface ParsedBulletLine {
  task: DailyTask
  /** True if this line had no `[gid:: ...]` tag and one was just minted for it. */
  mintedGid: boolean
}

function parseBulletLine(
  line: string,
  sectionHint: TaskSection,
  isDelegatedSection: boolean,
  allowPlainBullet: boolean
): ParsedBulletLine | null {
  const taskMatch = line.match(TASK_RE)
  let rest: string
  let status: TaskStatus = 'open'
  let isNote = false

  if (taskMatch) {
    status = STATUS_CHAR_TO_STATUS[taskMatch[2]!] ?? 'open'
    rest = taskMatch[3]!
  } else if (allowPlainBullet) {
    const plainMatch = line.match(PLAIN_BULLET_RE)
    if (!plainMatch || !plainMatch[2]!.trim()) return null
    rest = plainMatch[2]!
    isNote = true
  } else {
    return null
  }

  let remaining = rest

  // Time block, e.g. "09:30–12:00" or "09:30-12:00"
  let timeBlock: string | undefined
  const timeMatch = remaining.match(/^(\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2})\s+/)
  if (timeMatch) {
    timeBlock = timeMatch[1]!.replace(/\s+/g, '')
    remaining = remaining.slice(timeMatch[0]!.length)
  }

  // Generic inline metadata: [key:: value] — gid rides this same mechanism.
  const metadata: Record<string, string> = {}
  remaining = remaining.replace(/\[(\w+)::\s*([^\]]*)\]/g, (_m, key: string, value: string) => {
    metadata[key] = value.trim()
    return ''
  })

  // External links: [label](url)
  const externalLinks: ExternalLink[] = []
  remaining = remaining.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, label: string, url: string) => {
      externalLinks.push({ label, url })
      return ''
    }
  )

  // Tags: #word or #word/word
  const tags: string[] = []
  remaining = remaining.replace(/#[\w/]+/g, (tag) => {
    tags.push(tag)
    return ''
  })

  // Delegated-to suffix: " — PersonName"
  let delegatedTo: string | undefined
  const delegatedMatch = remaining.match(/\s+—\s+(\S.*)$/)
  if (delegatedMatch) {
    delegatedTo = delegatedMatch[1]!.trim()
    remaining = remaining.slice(0, delegatedMatch.index)
  }

  if (isDelegatedSection && !tags.includes('#delegated')) {
    tags.push('#delegated')
  }

  const text = remaining.trim()
  const isTracker = sectionHint === 'tracker' || tags.includes('#tracker')
  // A task's section is determined solely by which markdown heading it
  // physically sits under (sectionHint), never by whether its text happens
  // to carry a time-block-shaped prefix. Bug #57: this used to force any
  // line with a leading time-block onto 'day-plan' regardless of
  // sectionHint, so a task moved as-is (time-block prefix intact — exactly
  // what a human drag/cut-paste in Obsidian produces) from "## Tasks" into
  // "### Backlog" kept rendering in the Timeline forever, because the
  // parser silently re-promoted it back to day-plan on every reparse. The
  // watcher/push/reconcile pipeline (daily-notes-handlers.ts) was already
  // correctly detecting and pushing the external edit — the bug was purely
  // this line ignoring where the edit actually placed the task.
  const section: TaskSection = sectionHint
  const hadGid = metadata.gid !== undefined && metadata.gid.length > 0
  const gid = hadGid ? metadata.gid! : mintTaskId()

  return {
    task: {
      id: gid,
      gid,
      text,
      status,
      section,
      tags,
      scheduled: metadata.scheduled,
      completion: metadata.completion,
      due: metadata.due,
      timeBlock,
      externalLinks,
      delegatedTo,
      isTracker,
      isNote
    },
    mintedGid: !hadGid
  }
}

// ── section detection ────────────────────────────────────────────

type SectionKind =
  | 'frontmatter'
  | 'before-tasks'
  | 'tasks'
  | 'backlog'
  | 'delegated'
  | 'trackers'
  | 'after-tasks'
  | 'big-three'

function detectSection(line: string): SectionKind | null {
  const trimmed = line.trim()
  if (/^##\s+.*(Big\s*Three|Day\s*Plan)/i.test(trimmed)) return 'big-three'
  if (/^##\s+.*Tasks/i.test(trimmed)) return 'tasks'
  if (/^###\s+.*Backlog/i.test(trimmed)) return 'backlog'
  if (/^###\s+.*Delegated/i.test(trimmed)) return 'delegated'
  if (/^##\s+.*(Retro|Claude\s*Log|Notes)/i.test(trimmed)) return 'after-tasks'
  if (/>\s*\[!invisible]\s*Trackers/i.test(trimmed)) return 'trackers'
  return null
}

// ── parser ────────────────────────────────────────────────────────

export function parseDailyNote(
  content: string,
  date: string
): { note: DailyNote; raw: RawSections; mintedIds: string[] } {
  const lines = content.split('\n')
  const tasks: DailyTask[] = []
  // Ids minted during THIS parse for task lines that had no [gid:: ...] tag
  // in `content` — see daily-notes-handlers.ts's persistMintedGids, which
  // writes these back to disk so the next parse of the same file reuses
  // them instead of minting fresh (random, therefore different) ids again.
  const mintedIds: string[] = []
  const bigThreeItems: string[] = []
  const raw: RawSections = { frontmatter: [], beforeTasks: [], afterTasks: [] }

  let currentSection: SectionKind = 'frontmatter'
  let inFrontmatter = false
  let frontmatterDone = false
  let dayOfWeek = ''

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const dayMatch = fmMatch[1]!.match(/day:\s*(.+)/)
    if (dayMatch) dayOfWeek = dayMatch[1]!.trim()
  }

  for (const line of lines) {
    if (line.trim() === '---' && !frontmatterDone) {
      raw.frontmatter.push(line)
      if (!inFrontmatter) {
        inFrontmatter = true
      } else {
        inFrontmatter = false
        frontmatterDone = true
      }
      continue
    }
    if (inFrontmatter) {
      raw.frontmatter.push(line)
      continue
    }

    const detected = detectSection(line)
    if (detected !== null) currentSection = detected

    switch (currentSection) {
      case 'frontmatter':
        break
      case 'before-tasks':
        if (detected !== 'tasks') raw.beforeTasks.push(line)
        break
      case 'tasks':
        if (detected !== 'tasks') {
          const parsed = parseBulletLine(line, 'day-plan', false, true)
          if (parsed) {
            tasks.push(parsed.task)
            if (parsed.mintedGid) mintedIds.push(parsed.task.id)
          }
        }
        break
      case 'backlog':
        if (detected !== 'backlog') {
          const parsed = parseBulletLine(line, 'unscheduled', false, true)
          if (parsed) {
            tasks.push(parsed.task)
            if (parsed.mintedGid) mintedIds.push(parsed.task.id)
          }
        }
        break
      case 'delegated':
        if (detected !== 'delegated') {
          const parsed = parseBulletLine(line, 'unscheduled', true, true)
          if (parsed) {
            tasks.push(parsed.task)
            if (parsed.mintedGid) mintedIds.push(parsed.task.id)
          }
        }
        break
      case 'trackers': {
        const stripped = line.replace(/^>\s?/, '')
        const parsed = parseBulletLine(stripped, 'tracker', false, true)
        if (parsed) {
          tasks.push(parsed.task)
          if (parsed.mintedGid) mintedIds.push(parsed.task.id)
        }
        break
      }
      case 'after-tasks':
        if (detected === 'trackers') break
        raw.afterTasks.push(line)
        break
      case 'big-three': {
        if (detected === 'big-three') break
        const bulletMatch = line.match(/^\s*\*\s+(.+)$/)
        if (bulletMatch) bigThreeItems.push(bulletMatch[1]!.trim())
        break
      }
    }
  }

  return { note: { date, dayOfWeek, tasks, bigThree: bigThreeItems }, raw, mintedIds }
}

// ── serializer ────────────────────────────────────────────────────

export function serializeTaskLine(task: DailyTask): string {
  const parts: string[] = []
  if (task.timeBlock) parts.push(task.timeBlock)
  if (task.text) parts.push(task.text)

  const visibleTags = task.tags.filter((t) => t !== '#delegated')
  if (visibleTags.length > 0) parts.push(visibleTags.join(' '))

  for (const link of task.externalLinks) parts.push(`[${link.label}](${link.url})`)
  if (task.delegatedTo) parts.push(`— ${task.delegatedTo}`)

  const metaParts: string[] = []
  if (task.scheduled) metaParts.push(`[scheduled:: ${task.scheduled}]`)
  if (task.completion) metaParts.push(`[completion:: ${task.completion}]`)
  if (task.due) metaParts.push(`[due:: ${task.due}]`)
  // gid always round-trips, minted lazily by the parser if missing.
  metaParts.push(`[gid:: ${task.gid}]`)
  if (metaParts.length > 0) parts.push(metaParts.join(' '))

  const prefix = task.isNote ? '-' : `- [${STATUS_TO_CHAR[task.status] ?? ' '}]`
  return `${prefix} ${parts.join(' ').replace(/[ \t]+/g, ' ').trim()}`
}

export function serializeDailyNote(note: DailyNote, raw: RawSections): string {
  const sections: string[] = []

  if (raw.frontmatter.length > 0) sections.push(raw.frontmatter.join('\n'))
  if (raw.beforeTasks.length > 0) {
    sections.push('')
    sections.push(...raw.beforeTasks)
  }

  if (note.bigThree.length > 0) {
    sections.push('')
    sections.push('## \u{1F5D3}\u{FE0F} Daily Big Three')
    sections.push('')
    for (const item of note.bigThree) sections.push(`* ${item}`)
  }

  sections.push('')
  sections.push('## \u{1F4CB} Tasks')
  sections.push('')
  for (const task of note.tasks.filter((t) => t.section === 'day-plan')) {
    sections.push(serializeTaskLine(task))
  }

  sections.push('')
  sections.push('### ⚪ Backlog')
  const backlog = note.tasks.filter((t) => t.section === 'unscheduled' && !t.tags.includes('#delegated'))
  if (backlog.length > 0) for (const task of backlog) sections.push(serializeTaskLine(task))
  else sections.push('- ')

  sections.push('')
  sections.push('### \u{1F91D} Delegated')
  const delegated = note.tasks.filter((t) => t.section === 'unscheduled' && t.tags.includes('#delegated'))
  if (delegated.length > 0) for (const task of delegated) sections.push(serializeTaskLine(task))
  else sections.push('- ')

  if (raw.afterTasks.length > 0) {
    sections.push('')
    sections.push(raw.afterTasks.join('\n'))
  }

  const trackers = note.tasks.filter((t) => t.section === 'tracker')
  if (trackers.length > 0) {
    sections.push('> [!invisible] Trackers')
    for (const task of trackers) sections.push(`> ${serializeTaskLine(task)}`)
  }

  return `${sections.join('\n')}\n`
}

// ── path resolution ──────────────────────────────────────────────

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/** ISO week-numbering year (moment/Obsidian's `gggg`) — the Thursday-shifted year, not the calendar year. */
export function getISOWeekYear(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  return date.getUTCFullYear()
}

export function resolveNotePath(date: string, vaultRoot: string): string {
  const d = new Date(`${date}T00:00:00`)
  const yyyy = d.getFullYear().toString()
  const mmm = MONTH_ABBREVS[d.getMonth()]!
  const ww = String(getISOWeek(d)).padStart(2, '0')
  return `${vaultRoot}/01.dailynotes/${yyyy}/${mmm}/${ww}/${date}.md`
}

export function getDayOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return DAY_NAMES[d.getDay()]!
}

/** `{{date:TOKEN}}` substitution for the subset of Obsidian/moment.js format tokens the vault template actually uses. */
function fillDateTokens(template: string, date: string): string {
  const d = new Date(`${date}T00:00:00`)
  const tokenValues: Record<string, string> = {
    'YYYY-MM-DD': date,
    dddd: getDayOfWeek(date),
    gggg: String(getISOWeekYear(d)),
    WW: String(getISOWeek(d)).padStart(2, '0')
  }
  return template.replace(/\{\{date:([^}]+)\}\}/g, (match, token: string) => tokenValues[token] ?? match)
}

/**
 * Fill a vault template (e.g. `92.templates/Daily Note Template.md`) in for a
 * brand-new daily note: substitute its `{{date:...}}` tokens, then insert
 * `carriedTasks` (see findMostRecentNoteDate / the carry-over scan in
 * daily-notes-handlers.ts) directly under the `## Tasks` heading —
 * preserving each task's original `gid` (serializeTaskLine always emits
 * `[gid:: ...]`) so it's recognizably the same task across days rather than
 * a freshly-minted duplicate.
 */
export function fillDailyNoteTemplate(template: string, date: string, carriedTasks: DailyTask[] = []): string {
  const filled = fillDateTokens(template, date)
  const lines = filled.split('\n')
  const tasksHeaderIdx = lines.findIndex((l) => /^##\s+.*Tasks/i.test(l))
  if (tasksHeaderIdx === -1 || carriedTasks.length === 0) return filled

  lines.splice(tasksHeaderIdx + 1, 0, ...carriedTasks.map((task) => serializeTaskLine(task)))
  return lines.join('\n')
}

/**
 * Generate the markdown body for a brand-new daily note. When `template` is
 * given (the real vault `92.templates/Daily Note Template.md` content, read
 * by the caller), the note is built from it via `fillDailyNoteTemplate`.
 * Otherwise falls back to a minimal built-in skeleton — used only for vaults
 * that don't have that template file.
 */
export function generateNewNote(date: string, carriedTasks: DailyTask[] = [], template: string | null = null): string {
  if (template !== null) return fillDailyNoteTemplate(template, date, carriedTasks)

  const dayName = getDayOfWeek(date)
  const lines: string[] = [
    '---',
    `date: ${date}`,
    `day: ${dayName}`,
    'type: daily',
    '---',
    '',
    '## \u{1F4CB} Tasks',
    '',
    ...carriedTasks.map((task) => serializeTaskLine(task)),
    ...(carriedTasks.length > 0 ? [''] : []),
    '### ⚪ Backlog',
    '- ',
    '',
    '### \u{1F91D} Delegated',
    '- ',
    '',
    '> [!invisible] Trackers',
    ''
  ]
  return lines.join('\n')
}
