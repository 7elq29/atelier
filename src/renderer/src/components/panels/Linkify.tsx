/**
 * Renders text with any http(s) URL turned into a clickable link that opens
 * the system default browser via Electron's `shell.openExternal` (07-
 * secondary-panels §7) — never an in-app/embedded navigation. Used anywhere
 * panel content can contain a URL: diff inline comments, file previews, chat
 * user messages, etc.
 */
const URL_RE = /(https?:\/\/[^\s<>\[\]()]+)/g

function normalizeExternalUrl(url: string): string {
  return url.replace(/[),.;:!?]+$/g, '')
}

export function openExternalLink(url: string): void {
  void window.atelier.openExternal(normalizeExternalUrl(url))
}

export default function Linkify({ text }: { text: string }): JSX.Element {
  // `split` with a capturing-group regex interleaves the URL matches
  // themselves into the result at odd indices — no need for a second,
  // separately-stateful `.test()` call against the same global regex.
  const parts = text.split(URL_RE)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            className="ext-link"
            data-testid="external-link"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openExternalLink(part)
            }}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}
