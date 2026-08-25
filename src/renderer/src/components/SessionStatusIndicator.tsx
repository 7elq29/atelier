/** Set 1 · Monoline session status glyphs (see UI mock session-status-icons). */

const VIEW = '0 0 16 16'

function IconPlay(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <path fill="currentColor" d="M6 4.5v7l6-3.5-6-3.5z" />
    </svg>
  )
}

function IconAlert(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M8 5v3.2" />
      <circle cx="8" cy="11" r="0.75" fill="currentColor" />
    </svg>
  )
}

function IconCircleDashed(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2.5 2.2"
      />
    </svg>
  )
}

function IconUnplug(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        d="M6 3v3M10 3v3M5 10h6l1 3H4l1-3z"
      />
    </svg>
  )
}

function IconLink(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        d="M6 10l4-4M5 7l-1 1a2.5 2.5 0 003.5 3.5l1-1M11 9l1-1a2.5 2.5 0 00-3.5-3.5l-1 1"
      />
    </svg>
  )
}

function IconTree(): JSX.Element {
  return (
    <svg viewBox={VIEW} aria-hidden>
      <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M8 2v4M5 6h6M6 6v2M10 6v2M4 10h8v3H4v-3z" />
    </svg>
  )
}

export function ApprovalNeededIcon(): JSX.Element {
  return (
    <span className="approval-needed-icon" aria-hidden>
      <IconAlert />
    </span>
  )
}

export function SessionStatusIndicator({ dotStatus }: { dotStatus: string }): JSX.Element {
  const statusClass = 'status-' + dotStatus

  if (dotStatus === 'waiting-input' || dotStatus === 'idle') {
    return (
      <span
        className={'session-status session-status-empty ' + statusClass}
        data-testid="session-dot"
        aria-hidden
      />
    )
  }

  let anim = ''
  let tone = 'tone-neutral'
  let icon: JSX.Element | null = null

  switch (dotStatus) {
    case 'working':
      tone = 'tone-working'
      anim = 'anim-blink'
      icon = <IconPlay />
      break
    case 'waiting-blocked':
      tone = 'tone-blocked'
      anim = 'anim-blink'
      icon = <IconAlert />
      break
    case 'startup-idle':
    case 'stale':
      tone = 'tone-faint'
      icon = <IconCircleDashed />
      break
    case 'disconnected':
      tone = 'tone-faint'
      icon = <IconUnplug />
      break
    case 'connecting':
      anim = 'anim-spin'
      icon = <IconLink />
      break
    case 'creating-worktree':
      anim = 'anim-blink'
      icon = <IconTree />
      break
    default:
      icon = null
  }

  if (!icon) {
    return (
      <span
        className={'session-status session-status-empty ' + statusClass}
        data-testid="session-dot"
        aria-hidden
      />
    )
  }

  return (
    <span
      className={['session-status', 'session-status-icon', statusClass, tone, anim].filter(Boolean).join(' ')}
      data-testid="session-dot"
    >
      {icon}
    </span>
  )
}
