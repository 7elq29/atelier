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
}

export type WeeklyPlanCreatePayload = {
  isoWeek: string
  data: WeeklyPlanWizardData
}
