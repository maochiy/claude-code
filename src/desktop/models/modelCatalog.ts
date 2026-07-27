import { modelSupportsAutoMode } from '../../utils/betas.js'
import { getContextWindowForModel } from '../../utils/context.js'
import {
  EFFORT_LEVELS,
  getDefaultEffortForModel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from '../../utils/effort.js'
import { isFastModeSupportedByModel } from '../../utils/fastMode.js'
import {
  getConfiguredModel,
  normalizeConfiguredModelId,
} from '../../utils/model/configuredModels.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { modelSupportsAdaptiveThinking } from '../../utils/thinking.js'
import { applyDesktopRuntimeConfiguration } from '../bootstrap/runtimeConfiguration.js'
import type {
  RuntimeEnvironment,
  RuntimeModelCatalog,
  RuntimeProviderConfiguration,
} from '../protocol/types.js'

export function resolveDesktopModelCatalog(
  environment: RuntimeEnvironment,
  providerConfiguration: RuntimeProviderConfiguration,
): RuntimeModelCatalog {
  applyDesktopRuntimeConfiguration(environment, providerConfiguration)

  const kernelOptions = getModelOptions()
  const models = providerConfiguration.models.map(configured => {
    const value = normalizeConfiguredModelId(configured.id).id
    const option = kernelOptions.find(candidate =>
      candidate.value === value ||
      (
        candidate.value === null &&
        normalizeConfiguredModelId(
          providerConfiguration.defaultModel ?? '',
        ).id === value
      ),
    )
    const resolvedModel =
      value === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(value)
    const configuredModel =
      getConfiguredModel(value) ?? getConfiguredModel(resolvedModel)
    const supportsEffort = modelSupportsEffort(resolvedModel)
    const supportedEffortLevels =
      configuredModel?.effortLevels !== undefined
        ? [...configuredModel.effortLevels]
        : supportsEffort
          ? EFFORT_LEVELS.filter(level => {
              if (level === 'max')
                return modelSupportsMaxEffort(resolvedModel)
              if (level === 'xhigh')
                return modelSupportsXhighEffort(resolvedModel)
              return true
            })
          : []
    const defaultEffort = supportsEffort
      ? getDefaultEffortForModel(resolvedModel)
      : undefined

    return {
      value,
      displayName: configured.name ?? option?.label ?? value,
      description:
        configured.description ?? option?.description ?? configured.id,
      contextWindow:
        configuredModel?.contextWindow ??
        getContextWindowForModel(resolvedModel),
      supportsEffort,
      supportedEffortLevels,
      ...(supportsEffort
        ? {
            defaultEffortLevel: getDisplayedEffortLevel(
              resolvedModel,
              defaultEffort,
            ),
          }
        : {}),
      supportsAdaptiveThinking:
        modelSupportsAdaptiveThinking(resolvedModel),
      supportsFastMode: isFastModeSupportedByModel(option?.value ?? value),
      supportsAutoMode: modelSupportsAutoMode(resolvedModel),
    }
  })

  const configuredDefaultModel = providerConfiguration.defaultModel
    ? normalizeConfiguredModelId(providerConfiguration.defaultModel).id
    : undefined
  return {
    defaultModel:
      configuredDefaultModel &&
      models.some(model => model.value === configuredDefaultModel)
        ? configuredDefaultModel
        : models[0]?.value,
    models,
  }
}
