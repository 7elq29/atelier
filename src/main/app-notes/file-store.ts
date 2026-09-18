import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { AppNoteRecord, AppNoteUpdate } from '../../shared/app-note-types'

const ATELIER_TAG = 'atelier'
const ARCHIVE_FOLDER = 'archive'

type NoteDocument = {
  id: string | null
  content: string
  tags: string[]
  tagged: boolean
}

function safeFileName(title: string): string {
  const normalized = title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ')
  return normalized.replace(/[. ]+$/g, '') || 'Untitled note'
}

function stablePathId(path: string): string {
  return createHash('sha256').update(path).digest('hex')
}

function splitFrontmatter(raw: string): { frontmatter: string[]; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: [], content: raw }
  return { frontmatter: match[1].split(/\r?\n/), content: raw.slice(match[0].length) }
}

function parseDocument(raw: string): NoteDocument {
  const { frontmatter, content } = splitFrontmatter(raw)
  const tagsIndex = frontmatter.findIndex((line) => /^tags:\s*/.test(line))
  const tagValues: string[] = []
  if (tagsIndex >= 0) {
    const inline = frontmatter[tagsIndex].match(/^tags:\s*\[(.*)\]\s*$/)?.[1] ?? ''
    tagValues.push(...inline.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean))
    for (let index = tagsIndex + 1; index < frontmatter.length && /^\s*-\s+/.test(frontmatter[index]); index += 1) {
      tagValues.push(frontmatter[index].replace(/^\s*-\s+/, '').trim().replace(/^#/, ''))
    }
  }
  const id = frontmatter.find((line) => /^atelier_note_id:\s*/.test(line))?.replace(/^atelier_note_id:\s*/, '').trim() || null
  return { id, content, tags: tagValues, tagged: tagValues.includes(ATELIER_TAG) }
}

function serializeDocument(raw: string, content: string, id: string, tagged: boolean): string {
  const { frontmatter } = splitFrontmatter(raw)
  const kept: string[] = []
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index]
    if (/^atelier_note_id:\s*/.test(line)) continue
    if (/^tags:\s*/.test(line)) {
      while (index + 1 < frontmatter.length && /^\s*-\s+/.test(frontmatter[index + 1])) index += 1
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  const preservedTags = parseDocument(raw).tags.filter((tag) => tag !== ATELIER_TAG)
  const tags = tagged ? [...preservedTags, ATELIER_TAG] : preservedTags
  if (tags.length > 0) kept.push('tags:', ...tags.map((tag) => `  - ${tag}`))
  kept.push(`atelier_note_id: ${id}`)
  return `---\n${kept.join('\n')}\n---\n${content}`
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, content, 'utf-8')
  renameSync(temporaryPath, path)
}

export class AppNoteFileStore {
  constructor(private readonly root: string) {}

  private noteRoot(): string {
    const result = resolve(this.root)
    if (!this.root.trim()) throw new Error('no Obsidian vault configured for Atelier notes')
    return result
  }

  private paths(): string[] {
    const root = this.noteRoot()
    if (!existsSync(root)) return []
    const visit = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === ARCHIVE_FOLDER ? [] : visit(path)
        return entry.isFile() && extname(entry.name).toLowerCase() === '.md' ? [path] : []
      })
    return visit(root)
  }

  private record(path: string): AppNoteRecord | undefined {
    const raw = readFileSync(path, 'utf-8')
    const document = parseDocument(raw)
    if (!document.tagged) return undefined
    const stats = statSync(path)
    return {
      id: document.id || stablePathId(relative(this.noteRoot(), path)),
      title: basename(path, '.md'),
      content: document.content,
      path,
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
      sortOrder: 0
    }
  }

  private locate(id: string): { path: string; record: AppNoteRecord } | undefined {
    for (const path of this.paths()) {
      const record = this.record(path)
      if (record?.id === id) return { path, record }
    }
    return undefined
  }

  list(): AppNoteRecord[] {
    return this.paths()
      .map((path) => this.record(path))
      .filter((note): note is AppNoteRecord => Boolean(note))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((note, index) => ({ ...note, sortOrder: index }))
  }

  get(id: string): AppNoteRecord | undefined {
    return this.locate(id)?.record
  }

  create(title = 'Untitled note'): AppNoteRecord {
    const root = this.noteRoot()
    mkdirSync(root, { recursive: true })
    const id = randomUUID()
    const path = this.uniquePath(root, safeFileName(title))
    atomicWrite(path, serializeDocument('', '', id, true))
    return this.record(path)!
  }

  import(note: Pick<AppNoteRecord, 'id' | 'title' | 'content'>): AppNoteRecord {
    const root = this.noteRoot()
    mkdirSync(root, { recursive: true })
    const path = this.uniquePath(root, safeFileName(note.title))
    atomicWrite(path, serializeDocument('', note.content, note.id, true))
    return this.record(path)!
  }

  update(id: string, patch: AppNoteUpdate): AppNoteRecord | undefined {
    const located = this.locate(id)
    if (!located) return undefined
    const raw = readFileSync(located.path, 'utf-8')
    const document = parseDocument(raw)
    let path = located.path
    if (patch.title !== undefined && safeFileName(patch.title) !== basename(path, '.md')) {
      const next = this.uniquePath(dirname(path), safeFileName(patch.title), path)
      renameSync(path, next)
      path = next
    }
    atomicWrite(path, serializeDocument(raw, patch.content ?? document.content, document.id || id, true))
    return this.record(path)
  }

  delete(id: string, permanently: boolean): boolean {
    const located = this.locate(id)
    if (!located) return false
    if (permanently) {
      unlinkSync(located.path)
      return true
    }
    const archive = join(this.noteRoot(), ARCHIVE_FOLDER)
    const raw = readFileSync(located.path, 'utf-8')
    const document = parseDocument(raw)
    const destination = this.uniquePath(archive, basename(located.path, '.md'))
    atomicWrite(destination, serializeDocument(raw, document.content, document.id || id, false))
    unlinkSync(located.path)
    return true
  }

  private uniquePath(directory: string, title: string, current?: string): string {
    let suffix = 0
    while (true) {
      const candidate = join(directory, `${title}${suffix ? ` ${suffix + 1}` : ''}.md`)
      if (candidate === current || !existsSync(candidate)) return candidate
      suffix += 1
    }
  }
}
