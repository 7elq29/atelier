import { useCallback, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark
} from '../../../../shared/session-bookmarks'
import { normalizeSessionBookmarkTarget } from '../../../../shared/session-bookmarks'
import { APP_BOOKMARK_DRAG_MIME, type AppBookmarkDragPayload } from '../../../../shared/app-bookmark-types'
import { openExternalLink } from '../panels/Linkify'
import {
  ATELIER_FILE_SCHEME,
  hrefToAtelierFilePath,
  linkifyFilePathsInMarkdown,
  looksLikeFilePath,
  resolveKnownSessionFilePath
} from './file-path-links'
import ChatBookmarkContextMenu, {
  type ChatBookmarkMenuState
} from './ChatBookmarkContextMenu'

export type MarkdownLinkOptions = {
  workspaceRoot?: string
  projectRoot?: string
  filePathCandidates?: readonly string[]
  onOpenFileInFiles?: (absolutePath: string) => void
  onBookmarkRequest?: (
    event: React.MouseEvent,
    bookmark: CreateSessionBookmarkInput
  ) => void
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return ''
}

/**
 * Renders assistant chat text as real Markdown (12-markdown-message-
 * rendering), replacing the plain-text `<Linkify>` path for the final
 * plain-assistant-text branch in `ChatTranscript.tsx`. Scope is intentionally
 * narrow: only that branch uses this component directly — user messages
 * (`.msg-user`), other structured cards (`ToolCallCard`/`AskUserQuestionCard`/
 * `PermissionRequestCard`/todo updates/image attachments) are untouched.
 * `PlanProposedCard` reuses `createMarkdownComponents` with its own
 * `<ReactMarkdown>` instance rather than this component, since it renders
 * inside its own `.plan-body` wrapper.
 *
 * Uses `react-markdown` (+ `remark-gfm` for tables/strikethrough/task
 * lists) rather than a hand-rolled parser — renders to real React elements,
 * never `dangerouslySetInnerHTML`, which matters since this content
 * originates from model output. Visual styling for headings/code/lists is
 * applied entirely via CSS scoped under `.msg-assistant` in `global.css`
 * (`:where(h1,h2,...)`-style selectors) rather than per-tag class props
 * here, so plain `react-markdown` output (no custom `code`/`pre`
 * components needed) is enough — inline `<code>` vs a fenced `<pre><code>`
 * block are told apart purely by the `.msg-assistant pre code` CSS
 * override, no `inline` prop (react-markdown v9+ dropped it) needed.
 *
 * The one required custom override is `a`: links must open via the same
 * `openExternalLink()` / `window.atelier.openExternal()` IPC path
 * `Linkify.tsx` already uses for auto-linkified plain URLs — never a raw
 * in-app navigation. Paths use the `atelier-file:` scheme and open in the
 * Files tab when `onOpenFileInFiles` is provided.
 */
export function createMarkdownComponents(options: MarkdownLinkOptions = {}): Components {
  const {
    workspaceRoot = '',
    projectRoot = '',
    filePathCandidates,
    onOpenFileInFiles,
    onBookmarkRequest
  } = options

  return {
    a: ({ href, children, ...props }) => {
      const encodedFilePath = href ? hrefToAtelierFilePath(href) : null
      const filePath =
        encodedFilePath ??
        (href && looksLikeFilePath(href)
          ? resolveKnownSessionFilePath(
              href,
              workspaceRoot,
              projectRoot,
              filePathCandidates
            )
          : null)
      if (filePath && onOpenFileInFiles) {
        const fileHref = `${ATELIER_FILE_SCHEME}${encodeURIComponent(filePath)}`
        return (
          <a
            {...props}
            href={fileHref}
            data-testid="msg-file-link"
            onContextMenu={(e) => {
              if (!onBookmarkRequest) return
              e.preventDefault()
              e.stopPropagation()
              onBookmarkRequest(e, {
                kind: 'file',
                target: normalizeSessionBookmarkTarget('file', filePath),
                label: nodeText(children).trim() || filePath
              })
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenFileInFiles(filePath)
            }}
          >
            {children}
          </a>
        )
      }
      if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>
      return (
        <a
          {...props}
          href={href}
          data-testid="external-link"
          draggable
          onDragStart={(e) => {
            if (!href || !/^https?:\/\//i.test(href)) return
            const label = nodeText(children).trim()
            const payload: AppBookmarkDragPayload = { url: href, title: label === href ? '' : label }
            e.dataTransfer.setData(APP_BOOKMARK_DRAG_MIME, JSON.stringify(payload))
            e.dataTransfer.setData('text/uri-list', href)
            e.dataTransfer.setData('text/plain', href)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onContextMenu={(e) => {
            if (!href || !/^https?:\/\//i.test(href) || !onBookmarkRequest) return
            e.preventDefault()
            e.stopPropagation()
            onBookmarkRequest(e, {
              kind: 'link',
              target: normalizeSessionBookmarkTarget('link', href),
              label: nodeText(children).trim() || href
            })
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (href) openExternalLink(href)
          }}
        >
          {children}
        </a>
      )
    },
    code: ({ className, children, ...props }) => {
      const isFenced = Boolean(className?.startsWith('language-'))
      if (isFenced || !onOpenFileInFiles || !workspaceRoot) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
      const text = String(children).replace(/\n$/, '')
      const resolved = resolveKnownSessionFilePath(
        text,
        workspaceRoot,
        projectRoot,
        filePathCandidates
      )
      if (!resolved || !looksLikeFilePath(text)) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
      const href = `${ATELIER_FILE_SCHEME}${encodeURIComponent(resolved)}`
      return (
        <a
          className={className}
          href={href}
          data-testid="msg-file-link"
          onContextMenu={(e) => {
            if (!onBookmarkRequest) return
            e.preventDefault()
            e.stopPropagation()
            onBookmarkRequest(e, {
              kind: 'file',
              target: normalizeSessionBookmarkTarget('file', resolved),
              label: text
            })
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenFileInFiles(resolved)
          }}
        >
          {text}
        </a>
      )
    }
  }
}

/** @deprecated use `createMarkdownComponents()` — kept for imports that pass no file-link options */
export const markdownComponents = createMarkdownComponents()

export default function MarkdownMessage({
  content,
  workspaceRoot,
  projectRoot,
  filePathCandidates,
  onOpenFileInFiles,
  bookmarks = [],
  onToggleBookmark
}: {
  content: string
  workspaceRoot?: string
  projectRoot?: string
  filePathCandidates?: readonly string[]
  onOpenFileInFiles?: (absolutePath: string) => void
  bookmarks?: readonly SessionBookmark[]
  onToggleBookmark?: (bookmark: CreateSessionBookmarkInput, bookmarked: boolean) => void
}): JSX.Element {
  const [bookmarkMenu, setBookmarkMenu] = useState<ChatBookmarkMenuState | null>(null)
  const closeBookmarkMenu = useCallback(() => setBookmarkMenu(null), [])
  const onBookmarkRequest = useCallback(
    (event: React.MouseEvent, bookmark: CreateSessionBookmarkInput) => {
      if (!onToggleBookmark) return
      setBookmarkMenu({ x: event.clientX, y: event.clientY, bookmark })
    },
    [onToggleBookmark]
  )
  const processed = useMemo(() => {
    if (!workspaceRoot || !onOpenFileInFiles) return content
    return linkifyFilePathsInMarkdown(
      content,
      workspaceRoot,
      projectRoot ?? workspaceRoot,
      filePathCandidates
    )
  }, [content, workspaceRoot, projectRoot, filePathCandidates, onOpenFileInFiles])

  const components = useMemo(
    () =>
      createMarkdownComponents({
        workspaceRoot,
        projectRoot: projectRoot ?? workspaceRoot,
        filePathCandidates,
        onOpenFileInFiles,
        onBookmarkRequest
      }),
    [workspaceRoot, projectRoot, filePathCandidates, onOpenFileInFiles, onBookmarkRequest]
  )

  return (
    <>
      <div className="md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={components}
          urlTransform={(url) =>
            url.startsWith(ATELIER_FILE_SCHEME) ? url : defaultUrlTransform(url)
          }
        >
          {processed}
        </ReactMarkdown>
      </div>
      {bookmarkMenu && onToggleBookmark ? (
        <ChatBookmarkContextMenu
          state={bookmarkMenu}
          bookmarked={bookmarks.some(
            (item) =>
              item.kind === bookmarkMenu.bookmark.kind &&
              item.target === bookmarkMenu.bookmark.target
          )}
          onToggle={onToggleBookmark}
          onClose={closeBookmarkMenu}
        />
      ) : null}
    </>
  )
}

export { ATELIER_FILE_SCHEME }
