/**
 * Minion attachment helpers.
 *
 * Important: USER_MESSAGE `attachments[]` must be **file names** under the
 * DevPod `attachments/` dir — NOT data URLs. Passing a data URL makes the
 * worker mkdir path segments from every `/` in the base64 (empty dirs, no
 * image bytes). Until we have a real upload RPC, inline data URLs in the
 * **message text** so the agent can decode them from chat.jsonl.
 */

import { nativeImage } from 'electron'
import type { HarnessFileInput } from './types'
import { MINION_CREATE_INTERACTION_MESSAGE_MAX } from './minion-http-client'

/** Offline createInteraction MySQL TEXT budget for one image. */
export const MINION_RPC_IMAGE_BYTES_BUDGET = 45_000
/**
 * Live USER_MESSAGE body budget for one image (higher — WS carries large
 * frames; keep enough detail that the agent can read UI text in screenshots).
 */
export const MINION_WS_IMAGE_BYTES_BUDGET = 450_000

export function attachmentToDataUrl(a: HarnessFileInput): string {
  const mime = a.mimeType || 'application/octet-stream'
  const data = a.data.replace(/\s+/g, '')
  return `data:${mime};base64,${data}`
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/**
 * Shrink an image so encoded JPEG bytes stay under `maxBytes`.
 * Non-images are returned unchanged.
 */
export function compressAttachmentForMinion(
  a: HarnessFileInput,
  maxBytes: number
): HarnessFileInput {
  if (!isImageMime(a.mimeType || '')) return a
  const raw = Buffer.from(a.data.replace(/\s+/g, ''), 'base64')
  if (raw.length === 0) return a
  // Already small enough — keep original (better fidelity for PNGs with UI text).
  if (raw.length <= maxBytes) return a

  let img = nativeImage.createFromBuffer(raw)
  if (img.isEmpty()) return a

  const { width, height } = img.getSize()
  // Prefer wider screenshots readable; 1600px is usually enough for UI chrome.
  const maxEdge = maxBytes >= 200_000 ? 1600 : 1280
  if (width > maxEdge || height > maxEdge) {
    const scale = maxEdge / Math.max(width, height)
    img = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'better'
    })
  }

  let quality = maxBytes >= 200_000 ? 88 : 80
  let jpeg = img.toJPEG(quality)
  while (jpeg.length > maxBytes && quality > 40) {
    quality -= 6
    jpeg = img.toJPEG(quality)
  }
  while (jpeg.length > maxBytes) {
    const size = img.getSize()
    if (size.width <= 480 && size.height <= 480) break
    img = img.resize({
      width: Math.max(1, Math.round(size.width * 0.75)),
      height: Math.max(1, Math.round(size.height * 0.75)),
      quality: 'better'
    })
    jpeg = img.toJPEG(Math.max(40, quality))
  }

  const base = (a.name || 'screenshot').replace(/\.[^.]+$/, '')
  return {
    mimeType: 'image/jpeg',
    data: jpeg.toString('base64'),
    name: `${base}.jpg`
  }
}

export function prepareAttachmentsForMinionRpc(
  attachments: HarnessFileInput[] | undefined
): HarnessFileInput[] | undefined {
  if (!attachments?.length) return attachments
  return attachments.map((a) => compressAttachmentForMinion(a, MINION_RPC_IMAGE_BYTES_BUDGET))
}

/** Higher-quality compress for live socket message-body inlining. */
export function prepareAttachmentsForMinionWs(
  attachments: HarnessFileInput[] | undefined
): HarnessFileInput[] | undefined {
  if (!attachments?.length) return attachments
  return attachments.map((a) => compressAttachmentForMinion(a, MINION_WS_IMAGE_BYTES_BUDGET))
}

export function minionRpcAttachmentsFit(
  text: string,
  attachments: HarnessFileInput[] | undefined
): boolean {
  if (!attachments?.length) return true
  let used = text.trim().length + 200
  for (const a of attachments) {
    used += attachmentToDataUrl(a).length + 80
  }
  return used <= MINION_CREATE_INTERACTION_MESSAGE_MAX
}
