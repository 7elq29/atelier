/**
 * Scratch store for unsaved Files-panel editor text.
 *
 * The Files editor only writes to the real file on ⌘S. Before this store,
 * navigating to another file in the tree reused the active editor tab and
 * disposed the Monaco model, silently destroying whatever had been typed. Each
 * edit is now mirrored into a buffer file under
 * `<userData>/editor-buffers/<sha256>.json`, so re-opening a path restores the
 * pending text instead of the (unchanged) disk content.
 *
 * Buffers are scratch state scoped to one app run: `purgeEditorBuffers()` runs
 * on startup and on `before-quit`, so a relaunch always shows real file
 * contents. A buffer is deleted as soon as its path is saved.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { logger } from '../logger'

type BufferFile = {
  path: string
  hostname: string | null
  content: string
  updatedAt: string
}

let bufferDir: string | undefined

/**
 * Mirrors `logger.ts`'s fallback: `app.getPath` throws outside a real Electron
 * run (the standalone probe scripts under `src/e2e/` execute via plain `node`).
 */
function getBufferDir(): string {
  if (!bufferDir) {
    let dir: string
    try {
      dir = join(app.getPath('userData'), 'editor-buffers')
    } catch {
      dir = join(tmpdir(), 'atelier-standalone-editor-buffers')
    }
    mkdirSync(dir, { recursive: true })
    bufferDir = dir
  }
  return bufferDir
}

/**
 * Absolute paths can exceed the 255-byte filename limit once encoded, so the
 * host+path key is hashed and the readable original kept inside the JSON.
 */
function bufferFileFor(path: string, hostname?: string | null): string {
  const key = `${hostname ?? 'local'}\u0000${path}`
  return join(getBufferDir(), `${createHash('sha256').update(key).digest('hex')}.json`)
}

/** Returns the pending text for a path, or `null` when nothing is buffered. */
export function readEditorBuffer(path: string, hostname?: string | null): string | null {
  const file = bufferFileFor(path, hostname)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as BufferFile
    return typeof parsed.content === 'string' ? parsed.content : null
  } catch (err) {
    logger.warn('editor-buffer:read:failed', {
      path,
      hostname: hostname ?? null,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

export function writeEditorBuffer(path: string, content: string, hostname?: string | null): void {
  const payload: BufferFile = {
    path,
    hostname: hostname ?? null,
    content,
    updatedAt: new Date().toISOString()
  }
  try {
    writeFileSync(bufferFileFor(path, hostname), JSON.stringify(payload), 'utf8')
  } catch (err) {
    logger.warn('editor-buffer:write:failed', {
      path,
      hostname: hostname ?? null,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

export function deleteEditorBuffer(path: string, hostname?: string | null): void {
  try {
    rmSync(bufferFileFor(path, hostname), { force: true })
  } catch (err) {
    logger.warn('editor-buffer:delete:failed', {
      path,
      hostname: hostname ?? null,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Absolute paths of every buffered edit, so the renderer can restore markers. */
export function listEditorBufferPaths(hostname?: string | null): string[] {
  const host = hostname ?? null
  let entries: string[]
  try {
    entries = readdirSync(getBufferDir())
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(getBufferDir(), entry), 'utf-8')) as BufferFile
      if (parsed.hostname === host && typeof parsed.path === 'string') paths.push(parsed.path)
    } catch {
      // A torn/partial buffer file is scratch state — skip it.
    }
  }
  return paths
}

/**
 * Drops every buffer. Called on startup (clearing crash leftovers) and on
 * `before-quit`, keeping unsaved text scoped to a single app run.
 */
export function purgeEditorBuffers(): void {
  let removed = 0
  try {
    for (const entry of readdirSync(getBufferDir())) {
      if (!entry.endsWith('.json')) continue
      rmSync(join(getBufferDir(), entry), { force: true })
      removed += 1
    }
  } catch (err) {
    logger.warn('editor-buffer:purge:failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return
  }
  if (removed > 0) logger.info('editor-buffer:purged', { removed })
}
