/**
 * Minion agent elicitations arrive as JSON in interaction message/text
 * (`INTERACTION_CONTENT_TYPE_ELICITATION`), not as Claude SDK tool events.
 */

export interface MinionElicitationOption {
  label: string
  description: string
}

export interface MinionElicitationQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: MinionElicitationOption[]
}

export interface MinionElicitation {
  callId: string
  questions: MinionElicitationQuestion[]
}

/** Parse Minion AskUserQuestion / elicitation JSON (version + call_id + questions). */
export function parseMinionElicitation(raw: string): MinionElicitation | null {
  const text = raw.trim()
  if (!text.startsWith('{') || !text.includes('call_id') || !text.includes('questions')) return null
  try {
    const obj = JSON.parse(text) as {
      version?: unknown
      call_id?: unknown
      questions?: unknown
    }
    const callId = typeof obj.call_id === 'string' ? obj.call_id.trim() : ''
    if (!callId || !Array.isArray(obj.questions) || obj.questions.length === 0) return null
    const questions: MinionElicitationQuestion[] = []
    for (const q of obj.questions) {
      if (!q || typeof q !== 'object') continue
      const rec = q as Record<string, unknown>
      const question = typeof rec.question === 'string' ? rec.question : ''
      const header = typeof rec.header === 'string' ? rec.header : 'Question'
      if (!question) continue
      const optionsRaw = Array.isArray(rec.options) ? rec.options : []
      const options: MinionElicitationOption[] = optionsRaw
        .map((o) => {
          if (!o || typeof o !== 'object') return null
          const opt = o as Record<string, unknown>
          const label = typeof opt.label === 'string' ? opt.label : ''
          if (!label) return null
          return {
            label,
            description: typeof opt.description === 'string' ? opt.description : ''
          }
        })
        .filter((o): o is MinionElicitationOption => o != null)
      questions.push({
        question,
        header,
        multiSelect: Boolean(rec.multiSelect),
        options
      })
    }
    if (questions.length === 0) return null
    return { callId, questions }
  } catch {
    return null
  }
}
