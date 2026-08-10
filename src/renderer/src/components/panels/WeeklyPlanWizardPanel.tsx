import { useCallback, useMemo, useState } from 'react'
import type {
  WeeklyPlanCarrySuggestion,
  WeeklyPlanContextLine,
  WeeklyPlanScheduleEntry,
  WeeklyPlanWizardContext,
  WeeklyPlanWizardData
} from '../../../../shared/weekly-plan-types'
import { WeeklyPlanScheduleStep } from './weekly-plan/WeeklyPlanScheduleStep'
import { syncScheduleEntries } from './weekly-plan/schedule-utils'
import { dedupeContextLines } from '../../../../shared/weekly-plan-dedupe'
import { isWeeklyPlanInstructionLine } from '../../../../shared/weekly-plan-filters'

const WP_STEPS = [
  {
    phase: 'Start',
    title: 'Weekly review & plan',
    lead: 'Retro last week, plan Big Three and ideas, then time-block what matters. Finishing writes your vault weekly note.'
  },
  {
    phase: 'Retro',
    title: 'After action review',
    lead: 'List 3–5 biggest wins from last week (## AFTER ACTION REVIEW in your weekly note).'
  },
  {
    phase: 'Retro',
    title: 'Last week & reflection',
    lead: "Prefilled from last week's weekly note when it exists. Score Big Three completion, then reflect."
  },
  {
    phase: 'Plan',
    title: 'Rejuvenation',
    lead: 'Three recovery commitments for the week (## REJUVENATION).'
  },
  {
    phase: 'Plan',
    title: 'Ideas',
    lead: "Backlog candidates for the week (## Ideas). Add carry-overs from last week's daily notes."
  },
  {
    phase: 'Plan',
    title: 'Weekly Big Three',
    lead: 'Three outcomes — not vague tasks. At least one should be #q2 (important, not urgent).'
  },
  {
    phase: 'Schedule',
    title: 'Schedule the week',
    lead: 'Drag items from Rejuvenation, Big Three, and Ideas onto the week board. #q2 timed blocks also populate Q2 Blocks.'
  }
] as const

function parsePct(p: string): number | null {
  if (String(p).trim().toLowerCase() === 'n/a') return 0
  const n = parseInt(String(p), 10)
  if (Number.isNaN(n)) return 0
  return Math.min(100, Math.max(0, n))
}

function ObsidianTagText({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(#(?:[a-zA-Z][\w/-]*))/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('#') ? (
          <span key={i} className="obs-tag">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function ContextPanel({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <aside className="wp-context-panel">
      <div className="wp-context-title">{title}</div>
      {hint ? <div className="wp-context-sub">{hint}</div> : null}
      {children}
    </aside>
  )
}

function listContainsTaskText(list: string[], text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return list.some((x) => x.trim() === t)
}

function mergedRejuvenationAndIdeas(data: WeeklyPlanWizardData): string[] {
  return [...data.rejuvenation, ...data.ideas]
}

function ContextLineEditor({ lines, done }: { lines: WeeklyPlanContextLine[]; done?: boolean }): JSX.Element {
  return (
    <>
      {lines.map((t, i) => (
        <div
          key={`${t.source}-${i}-${t.text.slice(0, 24)}`}
          className={`wp-context-item${done ? ' is-done' : ' is-open'}`}
          data-testid="weekly-plan-context-item"
        >
          <span className="wp-context-check">{done ? '✓' : ''}</span>
          <div className="wp-context-body">
            <div className={`wp-context-text${done ? ' is-done' : ''}`}>
              <ObsidianTagText text={t.text} />
            </div>
            <div className="wp-context-src">{t.source}</div>
          </div>
        </div>
      ))}
    </>
  )
}

function OpenTaskContextPanel({
  lines,
  targetValues,
  onAdd
}: {
  lines: WeeklyPlanContextLine[]
  targetValues: string[]
  onAdd: (line: WeeklyPlanContextLine) => void
}): JSX.Element {
  return (
    <>
      {lines.map((t, i) => {
        const added = listContainsTaskText(targetValues, t.text)
        return (
          <div
            key={`${t.source}-${i}-${t.text.slice(0, 24)}`}
            className="wp-context-item wp-context-item--actionable is-open"
            data-testid="weekly-plan-open-task-row"
          >
            <span className="wp-context-check" aria-hidden />
            <div className="wp-context-body">
              <div className="wp-context-text">
                <ObsidianTagText text={t.text} />
              </div>
              <div className="wp-context-src">{t.source}</div>
            </div>
            {added ? (
              <span className="wp-context-added">Added</span>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => onAdd(t)}>
                Add
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

interface WeeklyPlanWizardPanelProps {
  context: WeeklyPlanWizardContext & { initialData: WeeklyPlanWizardData }
  onClose: () => void
  onCreated: () => void
}

export default function WeeklyPlanWizardPanel({
  context,
  onClose,
  onCreated
}: WeeklyPlanWizardPanelProps): JSX.Element {
  const [step, setStep] = useState(0)
  const [data, setData] = useState<WeeklyPlanWizardData>(context.initialData)
  const [completedLines] = useState(() => dedupeContextLines([...context.lastWeekCompleted]))
  const [openLines] = useState(() => dedupeContextLines([...context.lastWeekOpen]))
  const [creating, setCreating] = useState(false)
  const [done, setDone] = useState(false)

  const prevWeek = context.prevWeek
  const bigThreeSuggestionWeek = context.bigThreeSuggestionWeek
  const isoWeek = context.isoWeek
  const isWide = step >= 1 && step <= 6

  const incompleteLastBigThree = useMemo(
    () =>
      data.lastBigThree.filter((row) => {
        if (!row.text.trim() || isWeeklyPlanInstructionLine(row.text)) return false
        const p = String(row.pct).trim().toLowerCase()
        if (p === 'n/a') return false
        const n = parseInt(p, 10)
        return Number.isNaN(n) || n < 100
      }),
    [data.lastBigThree]
  )

  const setPct = useCallback((i: number, val: string) => {
    let n = parseInt(String(val), 10)
    if (Number.isNaN(n)) n = 0
    n = Math.min(100, Math.max(0, n))
    setData((d) => {
      const lastBigThree = [...d.lastBigThree]
      lastBigThree[i] = { ...lastBigThree[i]!, pct: String(n) }
      return { ...d, lastBigThree }
    })
  }, [])

  const addOpenLineToList = useCallback((line: WeeklyPlanContextLine, field: 'rejuvenation' | 'ideas') => {
    const text = line.text.trim()
    if (!text) return
    setData((d) => {
      const list = [...d[field]]
      const slot = list.findIndex((x) => !x.trim())
      const idx = slot >= 0 ? slot : list.length
      if (idx >= list.length) list.push(text)
      else list[idx] = text
      return { ...d, [field]: list }
    })
  }, [])

  const addToBigThree = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setData((d) => {
      const bigThree = [...d.bigThree]
      const slot = bigThree.findIndex((x) => !x.trim())
      const at = slot >= 0 ? slot : bigThree.length
      if (at >= bigThree.length) bigThree.push(trimmed)
      else bigThree[at] = trimmed
      return { ...d, bigThree }
    })
  }, [])

  const lastWeekBigThreeSuggestions = useMemo(
    () => context.lastWeekWeeklyBigThree.filter((t) => t.trim() && !isWeeklyPlanInstructionLine(t)),
    [context.lastWeekWeeklyBigThree]
  )

  const bigThreeCarryRows = useMemo(() => {
    const rows: { key: string; text: string; hint: string }[] = []
    const seen = new Set<string>()
    for (const text of lastWeekBigThreeSuggestions) {
      const t = text.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      rows.push({ key: `weekly-${t}`, text: t, hint: `${bigThreeSuggestionWeek} · Weekly Big Three` })
    }
    for (const row of incompleteLastBigThree) {
      const text = row.text.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      const p = parsePct(row.pct)
      const hint =
        p !== null && p > 0 ? `${p}% complete · ${prevWeek}` : `Unfinished · ${prevWeek}`
      rows.push({ key: `retro-${text}`, text, hint })
    }
    return rows
  }, [incompleteLastBigThree, lastWeekBigThreeSuggestions, prevWeek, bigThreeSuggestionWeek])

  const finish = useCallback(async () => {
    setCreating(true)
    try {
      const payload = { ...data, scheduleEntries: syncScheduleEntries(data) }
      await window.atelier.createWeeklyPlan({ isoWeek, data: payload })
      setDone(true)
      setStep(WP_STEPS.length)
      onCreated()
    } finally {
      setCreating(false)
    }
  }, [data, isoWeek, onCreated])

  const nextLabel =
    step >= WP_STEPS.length
      ? 'Done'
      : step === WP_STEPS.length - 1
        ? creating
          ? 'Creating…'
          : 'Create weekly note'
        : 'Continue'

  async function onNext(): Promise<void> {
    if (step >= WP_STEPS.length) {
      onClose()
      return
    }
    if (step === WP_STEPS.length - 1) {
      await finish()
      return
    }
    setStep((s) => s + 1)
  }

  function renderStepBody(): JSX.Element {
    if (done || step >= WP_STEPS.length) {
      return (
        <div className="wp-done-card" data-testid="weekly-plan-done">
          <strong>{context.relativePath}</strong> was written to your vault with retro, plan, ideas, Big Three, and
          scheduled blocks.
        </div>
      )
    }

    const s = WP_STEPS[step]!

    if (step === 6) {
      return (
        <WeeklyPlanScheduleStep
          isoWeek={isoWeek}
          data={data}
          onChange={(scheduleEntries) => setData((d) => ({ ...d, scheduleEntries }))}
        />
      )
    }

    let main: JSX.Element
    let side: JSX.Element | null = null
    let sideTitle = ''
    let sideHint = ''

    if (step === 1) {
      main = (
        <>
          {data.wins.map((w, i) => (
            <div key={i} className="wp-field">
              <label>Win {i + 1}</label>
              <input
                className="input"
                value={w}
                placeholder="Biggest win…"
                onChange={(e) => {
                  const wins = [...data.wins]
                  wins[i] = e.target.value
                  setData((d) => ({ ...d, wins }))
                }}
              />
            </div>
          ))}
        </>
      )
      sideTitle = 'Completed last week'
      sideHint = `From ${prevWeek} dailies & weekly note.`
      side = <ContextLineEditor lines={completedLines} done />
    } else if (step === 2) {
      main = (
        <>
          {data.lastBigThree.map((row, i) => {
            const pct = parsePct(row.pct) ?? 0
            const sliderVal = pct
            const low = sliderVal < 40
            return (
              <div key={i} className="wp-big3-retro" data-idx={i}>
                <div className="wp-big3-retro-head">
                  <span className="wp-big3-retro-num">#{i + 1}</span>
                  <input
                    className="wp-plain-field"
                    value={row.text}
                    placeholder="Outcome from last week…"
                    onChange={(e) => {
                      const lastBigThree = [...data.lastBigThree]
                      lastBigThree[i] = { ...lastBigThree[i]!, text: e.target.value }
                      setData((d) => ({ ...d, lastBigThree }))
                    }}
                  />
                </div>
                <div className="wp-completion">
                  <label>Completion</label>
                  <div className="wp-completion-row">
                    <input
                      type="range"
                      className={`wp-completion-slider${low ? ' is-low' : ''}`}
                      min={0}
                      max={100}
                      step={5}
                      value={sliderVal}
                      style={{ ['--pct' as string]: `${sliderVal}%` }}
                      onChange={(e) => setPct(i, e.target.value)}
                      aria-label="Completion percent"
                    />
                    <span className="wp-completion-pct-wrap">
                      <input
                        type="text"
                        className="wp-completion-pct-input"
                        inputMode="numeric"
                        value={sliderVal}
                        onChange={(e) => setPct(i, e.target.value.replace(/\D/g, ''))}
                        aria-label="Completion percent"
                      />
                      <span className="wp-completion-pct-suffix">%</span>
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
          <div className="wp-field">
            <label>What worked? What didn&apos;t? Why? How would you change?</label>
            <textarea
              className="input"
              value={data.retroReflect}
              placeholder="Reflection…"
              onChange={(e) => setData((d) => ({ ...d, retroReflect: e.target.value }))}
            />
          </div>
        </>
      )
      sideTitle = 'Completed last week'
      sideHint = `Tasks marked done in ${prevWeek}.`
      side = <ContextLineEditor lines={completedLines} done />
    } else if (step === 3) {
      main = (
        <div className="wp-field">
          <label>Rejuvenation</label>
          {data.rejuvenation.map((r, i) => (
            <input
              key={i}
              className="input"
              style={{ marginBottom: 8 }}
              value={r}
              placeholder={`Rest / recovery ${i + 1}`}
              onChange={(e) => {
                const rejuvenation = [...data.rejuvenation]
                rejuvenation[i] = e.target.value
                setData((d) => ({ ...d, rejuvenation }))
              }}
            />
          ))}
        </div>
      )
      sideTitle = 'Still open'
      sideHint = 'Reference only — use Add to copy into Rejuvenation.'
      side = (
        <OpenTaskContextPanel
          lines={openLines}
          targetValues={mergedRejuvenationAndIdeas(data)}
          onAdd={(line) => addOpenLineToList(line, 'rejuvenation')}
        />
      )
    } else if (step === 4) {
      main = (
        <>
          <div className="wp-carry">
            <div className="wp-carry-head">Suggested carry-overs</div>
            <div className="wp-carry-hint">From daily note bullets (notes only) in {prevWeek} — Add puts the line into Ideas.</div>
            {context.carrySuggestions.map((c) => (
              <CarryRow
                key={c.id}
                item={c}
                added={listContainsTaskText(mergedRejuvenationAndIdeas(data), c.text)}
                onAdd={() => {
                  if (listContainsTaskText(mergedRejuvenationAndIdeas(data), c.text)) return
                  setData((d) => {
                    const ideas = [...d.ideas]
                    const slot = ideas.findIndex((x) => !x.trim())
                    const idx = slot >= 0 ? slot : ideas.length
                    if (idx >= ideas.length) ideas.push(c.text)
                    else ideas[idx] = c.text
                    return { ...d, ideas }
                  })
                }}
              />
            ))}
          </div>
          <ul className="wp-idea-list">
            {data.ideas.map((idea, i) => (
              <li key={i}>
                <span className="wp-idea-num">{i + 1}.</span>
                <input
                  className="input"
                  value={idea}
                  placeholder="Idea or candidate task…"
                  onChange={(e) => {
                    const ideas = [...data.ideas]
                    ideas[i] = e.target.value
                    setData((d) => ({ ...d, ideas }))
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="wp-idea-actions">
            <button type="button" className="btn btn-sm" onClick={() => setData((d) => ({ ...d, ideas: [...d.ideas, ''] }))}>
              + Add idea
            </button>
            <span className="wp-tag-hint">
              Obsidian tags inline: <code>#q2</code>, <code>#project/name</code>
            </span>
          </div>
        </>
      )
      sideTitle = 'Still open'
      sideHint = 'Open tasks & backlog — Add copies into Ideas (notes use Suggested carry-overs above).'
      side = (
        <OpenTaskContextPanel
          lines={openLines}
          targetValues={mergedRejuvenationAndIdeas(data)}
          onAdd={(line) => addOpenLineToList(line, 'ideas')}
        />
      )
    } else if (step === 5) {
      main = (
        <>
          <div className="wp-carry" data-testid="weekly-plan-big3-carry">
            <div className="wp-carry-head">Unfinished Big Three from {bigThreeSuggestionWeek}</div>
            <div className="wp-carry-hint">
              {bigThreeSuggestionWeek !== prevWeek
                ? `${prevWeek} has no planned outcomes yet — showing the latest weekly note with a filled ## WEEKLY BIG THREE.`
                : 'Add rolls an outcome into this week\u2019s Big Three.'}
            </div>
            {bigThreeCarryRows.length ? (
              bigThreeCarryRows.map((row) => (
                <div key={row.key} className="wp-carry-item">
                  <div>
                    <div>
                      <ObsidianTagText text={row.text} />
                    </div>
                    <div className="src">{row.hint}</div>
                  </div>
                  {listContainsTaskText(data.bigThree, row.text) ? (
                    <span className="wp-context-added">Added</span>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => addToBigThree(row.text)}>
                      Add
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="wp-carry-empty">
                No outcomes to suggest. Fill <code>## WEEKLY BIG THREE</code> in {prevWeek} (or an earlier weekly note),
                or score unfinished outcomes on the retro step.
              </div>
            )}
          </div>
          <div className="wp-inline-hint">
            At least one outcome should include an Obsidian tag like <code>#q2</code>.
          </div>
          {data.bigThree.map((b, i) => (
            <div key={i} className="wp-field">
              <label>Big Three #{i + 1}</label>
              <input
                className="input"
                value={b}
                placeholder="Outcome… #q2"
                onChange={(e) => {
                  const bigThree = [...data.bigThree]
                  bigThree[i] = e.target.value
                  setData((d) => ({ ...d, bigThree }))
                }}
              />
            </div>
          ))}
        </>
      )
      sideTitle = 'Carry into this week'
      sideHint = 'Unfinished last-week outcomes (from retro) + open tasks.'
      side = (
        <>
          {incompleteLastBigThree.length ? (
            <div className="wp-context-sub" style={{ marginTop: 0 }}>
              Unfinished Big Three · {prevWeek}
            </div>
          ) : null}
          {incompleteLastBigThree.map((row) => {
            const i = data.lastBigThree.indexOf(row)
            const p = parsePct(row.pct)
            const partial = p !== null && p > 0
            return (
              <div key={i} className={`wp-context-item${partial ? ' is-partial' : ' is-open'}`}>
                <span className="wp-context-check">{partial ? `${p}%` : ''}</span>
                <div className="wp-context-body">
                  <div className="wp-context-text">
                    <ObsidianTagText text={row.text} />
                  </div>
                  <div className="wp-context-src">Last week Big Three</div>
                </div>
              </div>
            )
          })}
          <div className="wp-context-sub">Open tasks &amp; backlog (deduped)</div>
          <ContextLineEditor lines={openLines} />
        </>
      )
    } else {
      main = <p className="wp-lead">{s.lead}</p>
    }

    const body = (
      <>
        <div className="wp-phase-label">{s.phase}</div>
        <h3 className="wp-title">{s.title}</h3>
        {side ? (
          <div className="wp-split">
            <div className="wp-split-main">{main}</div>
            <ContextPanel title={sideTitle} hint={sideHint}>
              {side}
            </ContextPanel>
          </div>
        ) : (
          main
        )}
      </>
    )

    return body
  }

  return (
    <div className="session-panel weekly-plan-panel" data-testid="weekly-plan-panel" data-panel="weekly-plan">
      <div className="weekly-plan-scope-bar">
        Opens from the <strong>+</strong> on Weekly plan when this week&apos;s file is missing. Writes{' '}
        <code>{context.relativePath}</code> when you finish.
      </div>
      <div className={`weekly-plan-main${isWide ? ' is-wide' : ''}`}>
        <div className="wp-progress" data-testid="weekly-plan-progress">
          {WP_STEPS.map((_, i) => (
            <span
              key={i}
              className={`wp-progress-dot${i < step ? ' done' : ''}${i === step ? ' active' : ''}`}
            />
          ))}
        </div>
        <div className="wp-body">{renderStepBody()}</div>
        <div className="wp-footer">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="weekly-plan-back"
            style={{ visibility: step === 0 ? 'hidden' : 'visible' }}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </button>
          <span className="wp-step-label" data-testid="weekly-plan-step-label">
            {step >= WP_STEPS.length ? 'Complete' : `Step ${step + 1} of ${WP_STEPS.length}`}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="weekly-plan-next"
            disabled={creating}
            onClick={() => void onNext()}
          >
            {nextLabel}
          </button>
          <button
            type="button"
            className="btn btn-icon btn-sm"
            title="Close"
            data-testid="weekly-plan-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

function CarryRow({
  item,
  added,
  onAdd
}: {
  item: WeeklyPlanCarrySuggestion
  added: boolean
  onAdd: () => void
}): JSX.Element {
  return (
    <div className="wp-carry-item">
      <div>
        <div>
          <ObsidianTagText text={item.text} />
        </div>
        <div className="src">{item.source}</div>
      </div>
      {added ? (
        <span style={{ fontSize: 13, color: 'var(--accent)' }}>Added</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={onAdd}>
          Add
        </button>
      )}
    </div>
  )
}
