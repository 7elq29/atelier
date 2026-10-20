/**
 * Minion attachment helpers — live WS wants data URLs; offline createInteraction
 * inlines into MySQL TEXT (~64KiB), so screenshots must be JPEG-compressed first.
 */

import { nativeImage } from 'electron'
import type { HarnessFileInput } from './types'
import { MINION_CREATE_INTERACTION_MESSAGE_MAX } from './minion-http-client'

/** Budget left for one data URL inside the createInteraction message body. */
const RPC_INLINE_BYTES_BUDGET = 45_000

export function attachmentToDataUrl(a: HarnessFileInput): string {
  const mime = a.mimeType || 'application/octet-stream'
  const data = a.data.replace(/\s+/g, '')
  return `data:${mime};base64,${data}`
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/**
 * Shrink an image so its base64 data URL fits createInteraction's TEXT column.
 * Non-images are returned unchanged (caller may still omit them if too large).
 */
export function compressAttachmentForMinionRpc(a: HarnessFileInput): HarnessFileInput {
  if (!isImageMime(a.mimeType || '')) return a
  const raw = Buffer.from(a.data.replace(/\s+/g, ''), 'base64')
  if (raw.length === 0) return a
  let img = nativeImage.createFromBuffer(raw)
  if (img.isEmpty()) return a

  const { width, height } = img.getSize()
  const maxEdge = 1280
  if (width > maxEdge || height > maxEdge) {
    const scale = maxEdge / Math.max(width, height)
    img = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'better'
    })
  }

  let quality = 80
  let jpeg = img.toJPEG(quality)
  while (jpeg.length > RPC_INLINE_BYTES_BUDGET && quality > 28) {
    quality -= 8
    jpeg = img.toJPEG(quality)
  }
  // Still huge — step down resolution.
  while (jpeg.length > RPC_INLINE_BYTES_BUDGET) {
    const size = img.getSize()
    if (size.width <= 320 && size.height <= 320) break
    img = img.resize({
      width: Math.max(1, Math.round(size.width * 0.7)),
      height: Math.max(1, Math.round(size.height * 0.7)),
      quality: 'good'
    })
    jpeg = img.toJPEG(Math.max(28, quality))
  }

  const base = (a.name || 'screenshot').replace(/\.[^.]+$/, '')
  return {
    mimeType: 'image/jpeg',
    data: jpeg.toString('base64'),
    name: `${base}.jpg`
  }
}

/** Compress every image attachment for the offline RPC path. */
export function prepareAttachmentsForMinionRpc(
  attachments: HarnessFileInput[] | undefined
): HarnessFileInput[] | undefined {
  if (!attachments?.length) return attachments
  return attachments.map(compressAttachmentForMinionRpc)
}

/** Rough check that inlined attachments will fit the TEXT column. */
export function minionRpcAttachmentsFit(
  text: string,
  attachments: HarnessFileInput[] | undefined
): boolean {
  if (!attachments?.length) return true
  // Mirror buildMinionSteerMessage overhead (~200 chars of preamble).
  let used = text.trim().length + 200
  for (const a of attachments) {
    used += attachmentToDataUrl(a).length + 80
  }
  return used <= MINION_CREATE_INTERACTION_MESSAGE_MAX
}
