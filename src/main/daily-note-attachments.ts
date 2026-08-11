import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DailyNotePasteImagePayload, DailyNotePasteImageResult } from '../shared/daily-note-types'

const ACCEPTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

function vaultRelativePath(absPath: string, vaultRoot: string): string {
  const root = vaultRoot.replace(/\/$/, '')
  if (absPath.startsWith(`${root}/`)) return absPath.slice(root.length + 1)
  if (absPath.startsWith(root)) return absPath.slice(root.length).replace(/^\//, '')
  return absPath
}

function isPathInsideRoot(absPath: string, vaultRoot: string): boolean {
  const root = vaultRoot.replace(/\/$/, '')
  return absPath === root || absPath.startsWith(`${root}/`)
}

/** Obsidian paste naming: `Pasted image YYYYMMDDHHmmss.ext` */
function obsidianPasteTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  )
}

function safeAttachmentPath(noteAbsolutePath: string, fileName: string): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null
  return join(dirname(noteAbsolutePath), fileName)
}

function nextPastedImageFileName(noteDir: string, ext: string, now = new Date()): string {
  const stamp = obsidianPasteTimestamp(now)
  let fileName = `Pasted image ${stamp}.${ext}`
  let suffix = 1
  while (existsSync(join(noteDir, fileName))) {
    fileName = `Pasted image ${stamp} ${suffix}.${ext}`
    suffix += 1
  }
  return fileName
}

export function saveDailyNotePastedImage(
  noteAbsolutePath: string,
  vaultRoot: string,
  payload: DailyNotePasteImagePayload
): DailyNotePasteImageResult {
  if (!ACCEPTED_IMAGE_MIME_TYPES.has(payload.mimeType)) {
    throw new Error(`unsupported image mime type: ${payload.mimeType}`)
  }
  if (!isPathInsideRoot(noteAbsolutePath, vaultRoot)) {
    throw new Error('daily note path is outside vault root')
  }

  const ext = MIME_TO_EXT[payload.mimeType] ?? 'png'
  const noteDir = dirname(noteAbsolutePath)
  const fileName = nextPastedImageFileName(noteDir, ext)
  const attachmentPath = join(noteDir, fileName)
  writeFileSync(attachmentPath, Buffer.from(payload.data, 'base64'))

  return {
    embedMarkdown: `![[${fileName}]]`,
    fileName,
    vaultRelativePath: vaultRelativePath(attachmentPath, vaultRoot)
  }
}

export function readDailyNoteAttachmentDataUrl(
  noteAbsolutePath: string,
  vaultRoot: string,
  fileName: string
): string | null {
  const attachmentPath = safeAttachmentPath(noteAbsolutePath, fileName)
  if (!attachmentPath || !isPathInsideRoot(attachmentPath, vaultRoot)) return null
  if (!existsSync(attachmentPath)) return null

  const ext = attachmentPath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream'
  const data = readFileSync(attachmentPath).toString('base64')
  return `data:${mimeType};base64,${data}`
}
