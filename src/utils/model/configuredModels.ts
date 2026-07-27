import { getAPIProvider } from './providers.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { ConfiguredModel, SettingsJson } from '../settings/types.js'

export type ConfigurableProvider = 'anthropic' | 'openai' | 'gemini' | 'grok'

const LEGACY_FAMILIES = ['haiku', 'sonnet', 'opus'] as const

function getLegacyPrefix(provider: ConfigurableProvider): string {
  switch (provider) {
    case 'openai':
      return 'OPENAI'
    case 'gemini':
      return 'GEMINI'
    case 'grok':
      return 'GROK'
    case 'anthropic':
      return 'ANTHROPIC'
  }
}

export function normalizeConfiguredModelId(modelId: string): {
  id: string
  contextWindow?: number
} {
  const trimmed = modelId.trim()
  if (/\[1m\]$/i.test(trimmed)) {
    return {
      id: trimmed.replace(/\[1m\]$/i, ''),
      contextWindow: 1_000_000,
    }
  }
  return { id: trimmed }
}

export function normalizeConfiguredModels(
  models: ConfiguredModel[],
): ConfiguredModel[] {
  const byId = new Map<string, ConfiguredModel>()
  for (const model of models) {
    const normalized = normalizeConfiguredModelId(model.id)
    if (!normalized.id) continue
    const existing = byId.get(normalized.id)
    byId.set(normalized.id, {
      ...existing,
      ...model,
      id: normalized.id,
      contextWindow:
        model.contextWindow ??
        normalized.contextWindow ??
        existing?.contextWindow,
    })
  }
  return [...byId.values()]
}

export function getLegacyConfiguredModels(
  provider: ConfigurableProvider,
): ConfiguredModel[] {
  const prefix = getLegacyPrefix(provider)
  const models: ConfiguredModel[] = []
  for (const family of LEGACY_FAMILIES) {
    const upperFamily = family.toUpperCase()
    const rawId =
      process.env[`${prefix}_DEFAULT_${upperFamily}_MODEL`] ??
      (provider === 'anthropic'
        ? undefined
        : process.env[`ANTHROPIC_DEFAULT_${upperFamily}_MODEL`])
    if (!rawId) continue
    const normalized = normalizeConfiguredModelId(rawId)
    models.push({
      id: normalized.id,
      name:
        process.env[`${prefix}_DEFAULT_${upperFamily}_MODEL_NAME`] ?? undefined,
      description:
        process.env[`${prefix}_DEFAULT_${upperFamily}_MODEL_DESCRIPTION`] ??
        undefined,
      contextWindow: normalized.contextWindow,
    })
  }
  return normalizeConfiguredModels(models)
}

export function resolveConfiguredDefaultModelId(
  provider: ConfigurableProvider,
  models: ConfiguredModel[],
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): string | undefined {
  if (models.length === 0) return undefined
  const configuredIds = new Set(models.map(model => model.id))
  const rawSetting = settings.model
  if (rawSetting) {
    const normalized = normalizeConfiguredModelId(rawSetting).id
    if (configuredIds.has(normalized)) return normalized
  }

  const alias =
    rawSetting === 'haiku' || rawSetting === 'sonnet' || rawSetting === 'opus'
      ? rawSetting
      : undefined
  if (alias) {
    const prefix = getLegacyPrefix(provider)
    const legacyId =
      process.env[`${prefix}_DEFAULT_${alias.toUpperCase()}_MODEL`] ??
      (provider === 'anthropic'
        ? undefined
        : process.env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`])
    if (legacyId) {
      const normalized = normalizeConfiguredModelId(legacyId).id
      if (configuredIds.has(normalized)) return normalized
    }
  }

  return models[0]?.id
}

export function getInitialConfiguredModels(
  provider: ConfigurableProvider,
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): ConfiguredModel[] {
  if (settings.modelType === provider && settings.models?.length) {
    return normalizeConfiguredModels(settings.models)
  }
  return getLegacyConfiguredModels(provider)
}

export function getConfiguredModels(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): ConfiguredModel[] {
  return normalizeConfiguredModels(settings.models ?? [])
}

export function getConfiguredModel(
  modelId: string,
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): ConfiguredModel | undefined {
  const normalized = normalizeConfiguredModelId(modelId).id
  return getConfiguredModels(settings).find(model => model.id === normalized)
}

export function hasConfiguredModelCatalog(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): boolean {
  return settings.models !== undefined && settings.models.length > 0
}

export function isConfiguredModelProvider(): boolean {
  const provider = getAPIProvider()
  return provider !== 'firstParty' && hasConfiguredModelCatalog()
}

export function getConfiguredDefaultModelId(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): string | undefined {
  const models = getConfiguredModels(settings)
  if (models.length === 0) return undefined
  const configured = settings.model
    ? normalizeConfiguredModelId(settings.model).id
    : undefined
  if (configured && models.some(model => model.id === configured)) {
    return configured
  }
  return models[0]?.id
}
