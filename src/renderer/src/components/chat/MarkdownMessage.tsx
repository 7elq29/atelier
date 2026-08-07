import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalLink } from '../panels/Linkify'
import {
  ATELIER_FILE_SCHEME,
  hrefToAtelierFilePath,
  linkifyFilePathsInMarkdown,
  looksLikeFilePath,
  resolveSessionFilePath
} from './file-path-links'

export type MarkdownLinkOptions = {
  workspaceRoot?: string
  projectRoot?: string
  onOpenFileInFiles?: (absolutePath: string) => void
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
  const { workspaceRoot = '', projectRoot = '', onOpenFileInFiles } = options

  return {
    a: ({ href, children, ...props }) => {
      const filePath = href ? hrefToAtelierFilePath(href) : null
      if (filePath && onOpenFileInFiles) {
        return (
          <a
            {...props}
            href={href}
            data-testid="msg-file-link"
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
      return (
        <a
          {...props}
          href={href}
          data-testid="external-link"
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
      const resolved = resolveSessionFilePath(text, workspaceRoot, projectRoot)
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
  onOpenFileInFiles
}: {
  content: string
  workspaceRoot?: string
  projectRoot?: string
  onOpenFileInFiles?: (absolutePath: string) => void
}): JSX.Element {
  const processed = useMemo(() => {
    if (!workspaceRoot || !onOpenFileInFiles) return content
    return linkifyFilePathsInMarkdown(content, workspaceRoot, projectRoot ?? workspaceRoot)
  }, [content, workspaceRoot, projectRoot, onOpenFileInFiles])

  const components = useMemo(
    () =>
      createMarkdownComponents({
        workspaceRoot,
        projectRoot: projectRoot ?? workspaceRoot,
        onOpenFileInFiles
      }),
    [workspaceRoot, projectRoot, onOpenFileInFiles]
  )

  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  )
}

export { ATELIER_FILE_SCHEME }
