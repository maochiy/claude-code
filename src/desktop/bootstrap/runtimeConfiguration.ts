import { setFlagSettingsInline } from '../../bootstrap/state.js'
import { clearOpenAIClientCache } from '../../services/api/openai/client.js'
import { enableConfigs } from '../../utils/config.js'
import { applySafeConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type {
  RuntimeEnvironment,
  RuntimeProviderConfiguration,
} from '../protocol/types.js'

let injectedEnvironmentKeys = new Set<string>()

export function applyDesktopRuntimeConfiguration(
  environment: RuntimeEnvironment,
  providerConfiguration?: RuntimeProviderConfiguration,
): void {
  for (const name of injectedEnvironmentKeys) delete process.env[name]
  injectedEnvironmentKeys = new Set(Object.keys(environment.variables))
  for (const [name, value] of Object.entries(environment.variables)) {
    process.env[name] = value
  }

  process.env.CLAUDE_CONFIG_DIR = environment.configDir
  process.env.CLAUDE_CODE_ENTRYPOINT = 'desktop-runtime'
  enableConfigs()
  setFlagSettingsInline(null)
  resetSettingsCache()
  const nativeSettings = getSettings_DEPRECATED()
  const hasNativeModelCatalog =
    nativeSettings.models !== undefined && nativeSettings.models.length > 0
  if (providerConfiguration && !hasNativeModelCatalog) {
    setFlagSettingsInline({
      modelType: providerConfiguration.modelType,
      ...(providerConfiguration.defaultModel
        ? { model: providerConfiguration.defaultModel }
        : {}),
      models: providerConfiguration.models,
    })
  }
  clearOpenAIClientCache()
  resetSettingsCache()
  applySafeConfigEnvironmentVariables()
}
