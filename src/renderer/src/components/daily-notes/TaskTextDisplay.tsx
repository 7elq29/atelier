import type { DailyTask } from '../../../../shared/daily-note-types'
import { visibleDailyNoteTagsForDisplay } from '../../../../shared/daily-note-tags'
import { mergeExternalLinks, parseExternalLinksFromTaskText } from '../../../../shared/task-priority'
import Linkify, { openExternalLink } from '../panels/Linkify'

interface TaskTextDisplayProps {
  task: Pick<DailyTask, 'text' | 'externalLinks' | 'tags'>
  onRemoveTag?: (tag: string) => void
  /** When false, show full text (e.g. while editing elsewhere). */
  clamp?: boolean
}

export function formatTaskDisplayTitle(
  task: Pick<DailyTask, 'text' | 'externalLinks' | 'tags'>
): string {
  const { text, externalLinks: embeddedLinks } = parseExternalLinksFromTaskText(task.text)
  const links = mergeExternalLinks(embeddedLinks, task.externalLinks)
  const parts = [text]
  for (const tag of visibleDailyNoteTagsForDisplay(task.tags)) parts.push(tag)
  for (const link of links) parts.push(link.label || link.url)
  return parts.join(' ')
}

/** Renders task label text, inline `#tags`, and vault `[label](url)` links. */
export default function TaskTextDisplay({
  task,
  onRemoveTag,
  clamp = true
}: TaskTextDisplayProps): JSX.Element {
  const tags = visibleDailyNoteTagsForDisplay(task.tags)
  const { text: displayText, externalLinks: embeddedLinks } = parseExternalLinksFromTaskText(task.text)
  const links = mergeExternalLinks(embeddedLinks, task.externalLinks)
  const title = formatTaskDisplayTitle(task)

  return (
    <span
      className={clamp ? 'dn-task-text-clamp' : undefined}
      title={clamp && title ? title : undefined}
      data-testid="task-text-display"
    >
      <Linkify text={displayText} />
      {tags.map((tag) => (
        <span className="dn-inline-tag" key={tag} data-testid="task-tag-chip">
          {tag}
          {onRemoveTag ? (
            <button
              type="button"
              className="dn-tag-chip-remove"
              data-testid="task-tag-remove"
              onClick={(e) => {
                e.stopPropagation()
                onRemoveTag(tag)
              }}
              aria-label={`remove tag ${tag}`}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {links.map((link) => (
        <span
          key={`${link.url}\0${link.label}`}
          className="ext-link dn-task-external-link"
          data-testid="task-external-link"
          data-link-url={link.url}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            openExternalLink(link.url)
          }}
        >
          {link.label}
        </span>
      ))}
    </span>
  )
}
