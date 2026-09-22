import { useCallback, useEffect, useMemo, useRef, useState, isValidElement, type ReactNode } from 'react'
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
import { rehypeMarkdownSourcePositions, selectedMarkdown } from './markdown-selection-copy'

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
/**
 * Module-level component so react-markdown sees a stable reference on every
 * createMarkdownComponents() call. If defined inline inside the returned
 * Components object, every recompute (filePathCandidates change, workspace
 * refresh, etc.) gives react-markdown a new function reference — it treats
 * that as a different component type, unmounts/remounts the <pre> DOM nodes,
 * and clears any active text selection inside the code block.
 */
function PreBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)

  // Extract the plain code text from the <code> child react-markdown injects.
  // Structure for a fenced block: <pre> → <code className="language-X">…text…</code>
  function getText(): string {
    if (!isValidElement(children)) return typeof children === 'string' ? children : ''
    const codeEl = children as React.ReactElement<{ children?: ReactNode }>
    const inner = codeEl.props.children
    if (typeof inner === 'string') return inner
    if (Array.isArray(inner)) return inner.map((c) => (typeof c === 'string' ? c : '')).join('')
    return ''
  }

  function handleCopy(): void {
    void navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="md-pre-wrap">
      <pre>{children}</pre>
      <button
        type="button"
        className={`md-pre-copy-btn${copied ? ' md-pre-copy-btn--copied' : ''}`}
        title={copied ? 'Copied!' : 'Copy code'}
        onClick={handleCopy}
      >
        {copied ? (
          <svg className="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg className="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
    </div>
  )
}

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
      if (isFenced) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
      const text = String(children).replace(/\n$/, '')
      // Backtick-wrapped URLs (common in LLM output) — render as a real link.
      if (/^https?:\/\//i.test(text)) {
        return (
          <a
            href={text}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternalLink(text) }}
          >
            {text}
          </a>
        )
      }
      if (!onOpenFileInFiles || !workspaceRoot) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
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
    },
    pre: PreBlock
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
  const markdownRootRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    function handleCopy(event: ClipboardEvent): void {
      const root = markdownRootRef.current
      if (!root) return
      const markdown = selectedMarkdown(root, content)
      if (markdown == null) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', markdown)
    }
    document.addEventListener('copy', handleCopy)
    return () => document.removeEventListener('copy', handleCopy)
  }, [content])

  return (
    <>
      <div className="md-body" ref={markdownRootRef}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeMarkdownSourcePositions]}
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
