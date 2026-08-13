/** Split-pane review affordance — matches mocks `#icon-review` / MessageActions. */
export default function ReviewPaneIconButton({
  title,
  testId,
  active,
  onClick
}: {
  title: string
  testId: string
  active?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      className={active ? 'review-active' : undefined}
      onClick={onClick}
    >
      <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="8" height="16" rx="1.5" />
        <rect x="13" y="4" width="8" height="16" rx="1.5" />
        <line x1="7" y1="8" x2="7" y2="8.01" />
        <line x1="17" y1="8" x2="17" y2="8.01" />
        <line x1="7" y1="12" x2="7" y2="16" />
        <line x1="17" y1="12" x2="17" y2="16" />
      </svg>
    </button>
  )
}
