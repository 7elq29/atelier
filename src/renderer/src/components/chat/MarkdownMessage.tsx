import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalLink } from '../panels/Linkify'

/**
 * Renders assistant chat text as real Markdown (12-markdown-message-
 * rendering), replacing the plain-text `<Linkify>` path for the final
 * plain-assistant-text branch in `ChatTranscript.tsx`. Scope is intentionally
 * narrow: only that branch uses this component — user messages
 * (`.msg-user`), structured cards (`ToolCallCard`/`PlanProposedCard`/
 * `AskUserQuestionCard`/`PermissionRequestCard`/todo updates/image
 * attachments), and `PlanProposedCard`'s own hand-rolled parser are
 * untouched.
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
 * `openExternalLink()` / `window.gardenia.openExternal()` IPC path
 * `Linkify.tsx` already uses for auto-linkified plain URLs — never a raw
 * in-app navigation.
 */
const components: Components = {
  a: ({ href, children, ...props }) => (
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
}

export default function MarkdownMessage({ content }: { content: string }): JSX.Element {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
