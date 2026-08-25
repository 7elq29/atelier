import type { ModelInfo } from '../../../../shared/session-types'
import {
  contextLabelForModelId,
  defaultModelPickerOptions,
  displayNameForModelId,
  type ModelPickerOption
} from '../../../../shared/model-picker-catalog'

/** Prefer catalog context variants; overlay live SDK display names when init completes. */
export function resolveModelPickerOptions(liveModels: ModelInfo[] | undefined): ModelPickerOption[] {
  const catalog = defaultModelPickerOptions()
  if (!liveModels?.length) return catalog
  const liveByValue = new Map(liveModels.map((model) => [model.value, model]))
  return catalog.map((opt) => {
    const live = liveByValue.get(opt.id)
    return live ? { ...opt, displayName: live.displayName } : opt
  })
}

export function modelLabelForSelection(modelId: string | undefined, options: ModelPickerOption[]): string {
  if (!modelId) return options[0]?.displayName ?? 'Sonnet 5'
  const match = options.find((opt) => opt.id === modelId)
  if (match) return match.displayName
  return displayNameForModelId(modelId)
}
