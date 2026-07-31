/**
 * Real filesystem walk + file reads for the Files/Explorer panel
 * (07-secondary-panels §3). Walks the session's actual `project_path` on
 * disk via Node's `fs`, honoring a simple (non-exhaustive) `.gitignore` at
 * the project root, and classifies files for text/image/HTML rendering.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import type { FileKind, FileReadResult, FileTreeNode } from '../../shared/panel-types'

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.DS_Store'])
const MAX_ENTRIES = 3000

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const HTML_EXTENSIONS = new Set(['html', 'htm'])
const BINARY_EXTENSIONS = new Set(['pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'mp4', 'mp3', 'wasm'])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

/** Very small `.gitignore` matcher: supports plain names, trailing-slash dir patterns, and `*.ext` globs. Not a full gitignore implementation by design (spec: "don't over-engineer"). */
function loadIgnoreMatchers(root: string): ((relPath: string, isDir: boolean) => boolean)[] {
  const gitignorePath = join(root, '.gitignore')
  if (!existsSync(gitignorePath)) return []
  const lines = readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  return lines.map((pattern) => {
    const dirOnly = pattern.endsWith('/')
    const clean = dirOnly ? pattern.slice(0, -1) : pattern
    if (clean.startsWith('*.')) {
      const ext = clean.slice(2)
      return (relPath: string, isDir: boolean) => !isDir && relPath.split('/').pop()?.endsWith(`.${ext}`) === true
    }
    return (relPath: string, isDir: boolean) => {
      const segments = relPath.split('/')
      const matches = segments.includes(clean)
      return dirOnly ? matches && isDir : matches
    }
  })
}

function isIgnored(name: string, relPath: string, isDir: boolean, matchers: ((relPath: string, isDir: boolean) => boolean)[]): boolean {
  if (ALWAYS_IGNORED.has(name)) return true
  return matchers.some((m) => m(relPath, isDir))
}

/** Recursively walks `root`, returning a tree of directories-first-sorted nodes, capped at MAX_ENTRIES total to avoid pathological repos. */
export function walkFileTree(root: string): FileTreeNode[] {
  const matchers = loadIgnoreMatchers(root)
  let count = 0

  function walk(dir: string): FileTreeNode[] {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const nodes: FileTreeNode[] = []
    for (const name of entries.sort()) {
      if (count >= MAX_ENTRIES) break
      const full = join(dir, name)
      const rel = relative(root, full)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const isDir = stat.isDirectory()
      if (isIgnored(name, rel, isDir, matchers)) continue
      count++
      if (isDir) {
        nodes.push({ name, path: full, relativePath: rel, type: 'dir', children: walk(full) })
      } else {
        nodes.push({ name, path: full, relativePath: rel, type: 'file' })
      }
    }
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  }

  return walk(root)
}

export function readFileForPreview(path: string): FileReadResult {
  const ext = extname(path).slice(1).toLowerCase()

  if (IMAGE_EXTENSIONS.has(ext)) {
    const buf = readFileSync(path)
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    return { kind: 'image' as FileKind, content: `data:${mime};base64,${buf.toString('base64')}`, extension: ext }
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { kind: 'binary' as FileKind, content: '', extension: ext }
  }

  const text = readFileSync(path, 'utf-8')
  if (HTML_EXTENSIONS.has(ext)) {
    return { kind: 'html' as FileKind, content: text, extension: ext }
  }
  return { kind: 'text' as FileKind, content: text, extension: ext || basename(path) }
}
