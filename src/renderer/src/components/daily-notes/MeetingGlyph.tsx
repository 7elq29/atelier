/**
 * Two-person mark for `#meeting` / isNote rows — lives in the checkbox column.
 * Paths from Features/UI-Design/mocks/meeting-glyph-proposal.html.
 */
export default function MeetingGlyph({
  className,
  testId = 'meeting-glyph',
  title = 'Meeting'
}: {
  className?: string
  testId?: string
  title?: string
}): JSX.Element {
  return (
    <span
      className={className ? `dn-meeting-glyph ${className}` : 'dn-meeting-glyph'}
      data-testid={testId}
      title={title}
      aria-label={title}
      role="img"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="9.25" cy="8" r="3.1" />
        <path d="M4.2 18.6c.35-3.05 2.35-4.85 5.05-4.85s4.7 1.8 5.05 4.85" />
        <circle cx="15.6" cy="8.6" r="2.55" />
        <path d="M13.35 18.6c.2-2.15 1.35-3.45 3.35-3.55 2.15-.1 3.85 1.35 4.1 3.55" />
      </svg>
    </span>
  )
}
