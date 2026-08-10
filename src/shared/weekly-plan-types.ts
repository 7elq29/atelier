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
}

export type WeeklyPlanCreatePayload = {
  isoWeek: string
  data: WeeklyPlanWizardData
}
