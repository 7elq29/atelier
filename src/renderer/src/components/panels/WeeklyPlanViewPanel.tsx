import { useCallback, useEffect, useRef, useState } from 'react'
import type { WeeklyPlanScheduleEntry, WeeklyPlanViewResult, WeeklyPlanWizardData } from '../../../../shared/weekly-plan-types'
import { WeeklyPlanScheduleStep } from './weekly-plan/WeeklyPlanScheduleStep'

const WRITE_DEBOUNCE_MS = 500

function emptyScheduleData(entries: WeeklyPlanScheduleEntry[]): WeeklyPlanWizardData {
  return {
    wins: ['', '', ''],
    lastBigThree: [
      { text: '', pct: '0' },
      { text: '', pct: '0' },
      { text: '', pct: '0' }
    ],
    retroReflect: '',
    bigThree: ['', '', ''],
    rejuvenation: ['', '', ''],
    ideas: [],
    scheduleEntries: entries
  }
}

function PlanListSection({
  title,
  items,
  testId
}: {
  title: string
  items: string[]
  testId: string
}): JSX.Element {
  return (
    <section className="wp-view-section" data-testid={testId}>
      <h3 className="wp-view-section-title">{title}</h3>
      {items.length ? (
        <ol className="wp-view-list">
          {items.map((text, i) => (
            <li key={`${i}-${text}`}>{text}</li>
          ))}
        </ol>
      ) : (
        <p className="wp-view-empty">Nothing listed yet.</p>
      )}
    </section>
  )
}

export default function WeeklyPlanViewPanel({
  doc,
  effectiveTheme,
  onClose
}: {
  doc: WeeklyPlanViewResult
  effectiveTheme: 'light' | 'dark'
  onClose?: () => void
}): JSX.Element {
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [syncLabel, setSyncLabel] = useState('Synced')
  const [data, setData] = useState<WeeklyPlanWizardData>(() => emptyScheduleData(doc.scheduleEntries))

  useEffect(() => {
    setData(emptyScheduleData(doc.scheduleEntries))
    setSyncLabel('Synced')
  }, [doc])

  const scheduleSync = useCallback(
    (entries: WeeklyPlanScheduleEntry[], removedDailySourceKeys: string[]) => {
      setSyncLabel('Saving…')
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = setTimeout(() => {
        window.atelier
          .syncWeeklyPlanSchedule({ isoWeek: doc.isoWeek, scheduleEntries: entries, removedDailySourceKeys })
          .then((res) => {
            setData((prev) => ({ ...prev, scheduleEntries: res.scheduleEntries }))
            setSyncLabel('Synced')
          })
          .catch(() => setSyncLabel('Save failed'))
      }, WRITE_DEBOUNCE_MS)
    },
    [doc.isoWeek]
  )

  const onDataChange = useCallback(
    (update: WeeklyPlanWizardData | ((prev: WeeklyPlanWizardData) => WeeklyPlanWizardData)) => {
      setData((prev) => {
        const next = typeof update === 'function' ? update(prev) : update
        const prevDaily = prev.scheduleEntries
          .map((e) => e.sourceKey)
          .filter((k) => k.startsWith('daily_'))
        const nextDaily = new Set(next.scheduleEntries.map((e) => e.sourceKey).filter((k) => k.startsWith('daily_')))
        const removedDailySourceKeys = prevDaily.filter((k) => !nextDaily.has(k))
        scheduleSync(next.scheduleEntries, removedDailySourceKeys)
        return next
      })
    },
    [scheduleSync]
  )

  useEffect(
    () => () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    },
    []
  )

  return (
    <div
      className="session-panel weekly-plan-panel weekly-plan-view-panel"
      data-testid="weekly-plan-view-panel"
      data-effective-theme={effectiveTheme}
      data-panel="weekly-plan-view"
    >
      <div className="weekly-plan-scope-bar">
        <span>
          Weekly plan <strong>{doc.weekDateRange}</strong>
          <span className="weekly-plan-iso-hint"> ({doc.isoWeek})</span>
        </span>
        <span className="daily-note-vault-path" data-testid="weekly-plan-view-path" title={doc.relativePath}>
          {doc.relativePath}
        </span>
        <span className="daily-sync-chip synced" data-testid="weekly-plan-sync-chip">
          {syncLabel}
        </span>
        {onClose ? (
          <button type="button" className="btn btn-ghost btn-sm" data-testid="weekly-plan-view-close" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>

      <div className="weekly-plan-main weekly-plan-view-main">
        <div className="wp-view-body">
          <PlanListSection title="Weekly Big Three" items={doc.bigThree} testId="weekly-plan-view-big-three" />
          <PlanListSection title="Rejuvenation" items={doc.rejuvenation} testId="weekly-plan-view-rejuvenation" />
          <section className="wp-view-section wp-view-schedule" data-testid="weekly-plan-view-schedule">
            <h3 className="wp-view-section-title">Schedule</h3>
            <WeeklyPlanScheduleStep
              isoWeek={doc.isoWeek}
              weekLabel={doc.weekDateRange}
              data={data}
              onDataChange={onDataChange}
              embedded
            />
          </section>
        </div>
      </div>
    </div>
  )
}
