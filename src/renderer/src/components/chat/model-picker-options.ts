import type { ModelInfo } from '../../../../shared/session-types'
import {
  contextLabelForModelId,
  defaultModelPickerOptions,
  displayNameForModelId,
  type ModelPickerOption
} from '../../../../shared/model-picker-catalog'

/**
 * Prefer the live SDK `/model` list (`initializationResult().models`) as the
 * full picker. Fallback catalog is only used before that list arrives.
 */
export function resolveModelPickerOptions(liveModels: ModelInfo[] | undefined): ModelPickerOption[] {
  if (liveModels?.length) {
    return liveModels.map((model) => {
      const contextLabel =
        contextLabelForModelId(model.value) ??
        (model.resolvedModel ? contextLabelForModelId(model.resolvedModel) : undefined) ??
        ''
      return {
        id: model.value,
        displayName: model.displayName,
        contextLabel
      }
    })
  }
  return defaultModelPickerOptions()
}

export function modelLabelForSelection(modelId: string | undefined, options: ModelPickerOption[]): string {
  if (!modelId) return options[0]?.displayName ?? 'Default'
  const match = options.find((opt) => opt.id === modelId)
  if (match) return match.displayName
  return displayNameForModelId(modelId)
}
