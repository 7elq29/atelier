import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

const WIKI_IMAGE_EMBED_RE = /!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi

const imageDataLoaded = StateEffect.define<{ fileName: string; dataUrl: string }>()

class VaultEmbedImageWidget extends WidgetType {
  constructor(
    private readonly fileName: string,
    private readonly dataUrl: string | null
  ) {
    super()
  }

  eq(other: VaultEmbedImageWidget): boolean {
    return other.fileName === this.fileName && other.dataUrl === this.dataUrl
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-atomic-image'
    wrap.dataset.vaultEmbedImage = this.fileName
    if (this.dataUrl) {
      const img = document.createElement('img')
      img.src = this.dataUrl
      img.alt = this.fileName
      img.loading = 'lazy'
      wrap.appendChild(img)
    } else {
      wrap.classList.add('cm-atomic-image-loading')
      wrap.textContent = `Loading ${this.fileName}…`
    }
    return wrap
  }
}

function findWikiImageEmbeds(doc: string): Array<{ from: number; to: number; fileName: string }> {
  const matches: Array<{ from: number; to: number; fileName: string }> = []
  for (const match of doc.matchAll(WIKI_IMAGE_EMBED_RE)) {
    const raw = match[0]
    const fileName = match[1]
    if (!raw || !fileName) continue
    const from = match.index ?? 0
    matches.push({ from, to: from + raw.length, fileName })
  }
  return matches
}

function buildWikiEmbedDecorations(
  state: EditorView['state'],
  dataUrls: Map<string, string>
): { deco: DecorationSet; pending: string[] } {
  const ranges: ReturnType<Decoration['range']>[] = []
  const pending: string[] = []
  for (const embed of findWikiImageEmbeds(state.doc.toString())) {
    const line = state.doc.lineAt(embed.from)
    const dataUrl = dataUrls.get(embed.fileName) ?? null
    if (!dataUrl) pending.push(embed.fileName)
    ranges.push(
      Decoration.widget({
        widget: new VaultEmbedImageWidget(embed.fileName, dataUrl),
        block: true,
        side: 1
      }).range(line.to)
    )
  }
  return { deco: Decoration.set(ranges, true), pending }
}

async function fileToPastePayload(file: File): Promise<{ mimeType: string; data: string } | null> {
  if (!file.type.startsWith('image/')) return null
  const accepted = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  if (!accepted.has(file.type)) return null
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return { mimeType: file.type, data: btoa(binary) }
}

async function insertImageMarkdown(view: EditorView, markdownLine: string): Promise<void> {
  const { from, to } = view.state.selection.main
  const needsLeadingBreak = from > 0 && view.state.doc.sliceString(from - 1, from) !== '\n'
  const insert = `${needsLeadingBreak ? '\n' : ''}${markdownLine}\n`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length }
  })
}

async function handleImageFile(
  view: EditorView,
  file: File,
  onPasteImage: (payload: { mimeType: string; data: string }) => Promise<string | null>
): Promise<void> {
  const payload = await fileToPastePayload(file)
  if (!payload) return
  const markdownLine = await onPasteImage(payload)
  if (!markdownLine) return
  await insertImageMarkdown(view, markdownLine)
}

/** Intercept clipboard/drop image files and insert Obsidian wiki embed markdown. */
export function dailyNoteImagePasteExtension(
  onPasteImage: (payload: { mimeType: string; data: string }) => Promise<string | null>
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items
      if (!items) return false
      const imageItem = Array.from(items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))
      if (!imageItem) return false
      const file = imageItem.getAsFile()
      if (!file) return false
      event.preventDefault()
      void handleImageFile(view, file, onPasteImage)
      return true
    },
    drop(event, view) {
      const files = event.dataTransfer?.files
      if (!files?.length) return false
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (!file) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos != null) view.dispatch({ selection: { anchor: pos } })
      void handleImageFile(view, file, onPasteImage)
      return true
    }
  })
}

/** Live-preview widgets for `![[Pasted image …]]` embeds saved beside the note. */
export function dailyNoteWikiEmbedImagePreview(
  loadDataUrl: (fileName: string) => Promise<string | null>
): Extension {
  const dataUrls = new Map<string, string>()
  const inFlight = new Set<string>()
  let bootstrapped = false

  function queuePendingLoads(view: EditorView, pending: string[]): void {
    for (const fileName of pending) {
      if (dataUrls.has(fileName) || inFlight.has(fileName)) continue
      inFlight.add(fileName)
      void loadDataUrl(fileName).then((dataUrl) => {
        inFlight.delete(fileName)
        if (!dataUrl) return
        view.dispatch({
          effects: imageDataLoaded.of({ fileName, dataUrl })
        })
      })
    }
  }

  const field = StateField.define<DecorationSet>({
    create(state) {
      const { deco } = buildWikiEmbedDecorations(state, dataUrls)
      return deco
    },
    update(deco, tr) {
      let rebuilt = false
      for (const effect of tr.effects) {
        if (effect.is(imageDataLoaded)) {
          dataUrls.set(effect.value.fileName, effect.value.dataUrl)
          rebuilt = true
        }
      }
      if (rebuilt || tr.docChanged) {
        return buildWikiEmbedDecorations(tr.state, dataUrls).deco
      }
      return deco.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f)
  })

  return [
    field,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && bootstrapped) return
      bootstrapped = true
      const { pending } = buildWikiEmbedDecorations(update.state, dataUrls)
      queuePendingLoads(update.view, pending)
    })
  ]
}
