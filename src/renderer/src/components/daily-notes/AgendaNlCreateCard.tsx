import { useCallback, useState } from 'react'
import {
  formatDurationPhrase,
  formatStartPhrase,
  nearestDurIdx,
  NL_DUR_STEPS_MIN,
  parseTaskNl,
  replaceNlEntity,
  type NlEntityKind,
  type NlParseResult,
} from '../../../../shared/task-nl-parse'
import NlAnnotatedInput from './NlAnnotatedInput'
import NlDurationPopover from './NlDurationPopover'
import NlTimePopover from './NlTimePopover'

export interface NlCreateDraft {
  startMin: number
  durIdx: number
  text: string
  cardX: number
  cardY: number
  noTime?: boolean
}

interface AgendaNlCreateCardProps {
  draft: NlCreateDraft
  onDraftChange: (next: NlCreateDraft) => void
  onCommit: (content: string, timeBlock: string) => void
  onCancel: () => void
  cardRef: React.RefObject<HTMLDivElement | null>
}

export default function AgendaNlCreateCard({
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  cardRef,
}: AgendaNlCreateCardProps): JSX.Element {
  const [entityPop, setEntityPop] = useState<{ kind: NlEntityKind; anchor: DOMRect } | null>(null)

  const left = Math.min(draft.cardX + 12, window.innerWidth - 440)
  const top = Math.max(8, Math.min(draft.cardY - 40, window.innerHeight - 200))

  const applyParsed = useCallback(
    (raw: string, parsed: NlParseResult) => {
      const durIdx =
        parsed.durationMin != null
          ? nearestDurIdx(parsed.durationMin, NL_DUR_STEPS_MIN)
          : draft.durIdx
      onDraftChange({
        ...draft,
        text: raw,
        startMin: parsed.startMin ?? draft.startMin,
        durIdx,
        noTime: parsed.startMin == null && draft.noTime ? true : parsed.startMin == null ? draft.noTime : false,
      })
    },
    [draft, onDraftChange]
  )

  function commitFromRaw(raw: string): void {
    const parsed = parseTaskNl(raw)
    const content = parsed.content.trim()
    if (!content) {
      onCancel()
      return
    }
    if (draft.noTime) {
      onCommit(content, '')
      return
    }
    // Prefer parsed clock/duration; fall back to draft defaults from right-click slot
    const startMin = parsed.startMin ?? draft.startMin
    const durMin = parsed.durationMin ?? NL_DUR_STEPS_MIN[draft.durIdx] ?? 30
    const endMin = startMin + durMin
    const h = (m: number) => {
      const hh = Math.floor(m / 60)
      const mm = m % 60
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
    onCommit(content, `${h(startMin)}-${h(endMin)}`)
  }

  function onEntityClick(kind: NlEntityKind, rect: DOMRect): void {
    if (kind === 'tag') return
    setEntityPop({ kind, anchor: rect })
  }

  function setStartMin(startMin: number): void {
    const nextRaw = replaceNlEntity(draft.text, 'time', formatStartPhrase(startMin))
    onDraftChange({ ...draft, text: nextRaw, startMin, noTime: false })
  }

  function setDurationMin(durationMin: number): void {
    const durIdx = nearestDurIdx(durationMin, NL_DUR_STEPS_MIN)
    const nextRaw = replaceNlEntity(draft.text, 'duration', formatDurationPhrase(durationMin))
    onDraftChange({ ...draft, text: nextRaw, durIdx })
  }

  const durMin = NL_DUR_STEPS_MIN[draft.durIdx] ?? 30

  return (
    <>
      <div
        ref={cardRef as React.RefObject<HTMLDivElement>}
        className="dn-nl-card"
        data-testid="agenda-nl-create"
        style={{ left: Math.max(8, left), top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <NlAnnotatedInput
          value={draft.text}
          autoFocus
          testId="agenda-create-input"
          openKind={entityPop?.kind ?? null}
          onChange={applyParsed}
          onCommit={(parsed) => commitFromRaw(parsed.raw)}
          onCancel={onCancel}
          onEntityClick={onEntityClick}
        />
        <div className="dn-nl-card-foot">
          <span><kbd>↵</kbd> Add</span>
        </div>
      </div>

      {entityPop?.kind === 'time' && !draft.noTime && (
        <NlTimePopover
          startMin={draft.startMin}
          anchor={entityPop.anchor}
          allowClear
          onClear={() => {
            // Strip time phrase
            const parsed = parseTaskNl(draft.text)
            const withoutTime = parsed.segments
              .filter((s) => s.kind !== 'time')
              .map((s) => s.text)
              .join('')
              .replace(/\s{2,}/g, ' ')
              .trim()
            onDraftChange({ ...draft, text: withoutTime, noTime: true })
            setEntityPop(null)
          }}
          onChange={setStartMin}
          onCommit={() => setEntityPop(null)}
          onCancel={() => setEntityPop(null)}
        />
      )}
      {entityPop?.kind === 'duration' && (
        <NlDurationPopover
          durationMin={durMin}
          anchor={entityPop.anchor}
          onChange={setDurationMin}
          onCommit={() => setEntityPop(null)}
          onCancel={() => setEntityPop(null)}
        />
      )}
    </>
  )
}
