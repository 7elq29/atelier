export type WeeklyPlanBigThreeRetroRow = {
  text: string
  /** Percent 0–100, or the literal `n/a`. */
  pct: string
}

export type WeeklyPlanContextLine = {
  text: string
  source: string
}

export type WeeklyPlanCarrySuggestion = {
  id: string
  text: string
  source: string
}

export type WeeklyPlanScheduleKind = 'Rejuvenation' | 'Big Three' | 'Idea'

export type WeeklyPlanScheduleEntry = {
  id: string
  sourceKey: string
  text: string
  kind: WeeklyPlanScheduleKind
  day: string
  slot: string
  splitGroup?: string
  /** From daily-note checkbox state when loaded from vault. */
  status?: 'open' | 'done' | 'forwarded' | 'in-progress' | 'cancelled'
  /** Plain bullet / #meeting line from daily notes (not a checkbox task). */
  isNote?: boolean
}

export type WeeklyPlanWizardData = {
  wins: string[]
  lastBigThree: WeeklyPlanBigThreeRetroRow[]
  retroReflect: string
  rejuvenation: string[]
  ideas: string[]
  bigThree: string[]
  scheduleEntries: WeeklyPlanScheduleEntry[]
}

export type WeeklyPlanStatus = {
  isoWeek: string
  /** Mon–Sun range, e.g. "Jul 28 – Aug 3, 2026". */
  weekDateRange: string
  prevWeek: string
  relativePath: string
  fileExists: boolean
}

export type WeeklyPlanWizardContext = WeeklyPlanStatus & {
  carrySuggestions: WeeklyPlanCarrySuggestion[]
  lastWeekCompleted: WeeklyPlanContextLine[]
  lastWeekOpen: WeeklyPlanContextLine[]
  /** Lines from previous week's `## Weekly Big Three` section (suggestions for this week). */
  lastWeekWeeklyBigThree: string[]
  /** Week label for Big Three carry suggestions (prev week, or latest vault week with outcomes). */
  bigThreeSuggestionWeek: string
  /** Saved wizard step when resuming an in-progress draft (0 if none). */
  draftStep: number
}

export type WeeklyPlanDraftPayload = {
  isoWeek: string
  step: number
  data: WeeklyPlanWizardData
}

export type WeeklyPlanCreatePayload = {
  isoWeek: string
  data: WeeklyPlanWizardData
}

/** Vault weekly note file for in-app read-only preview. */
export type WeeklyPlanReadResult = {
  isoWeek: string
  relativePath: string
  markdown: string
}

/** Structured weekly plan surface (Big Three, Rejuvenation, schedule from daily notes). */
export type WeeklyPlanViewResult = WeeklyPlanReadResult & {
  weekDateRange: string
  bigThree: string[]
  rejuvenation: string[]
  scheduleEntries: WeeklyPlanScheduleEntry[]
}
