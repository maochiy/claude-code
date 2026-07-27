import {
  resolveGeminiModel,
  resolveGrokModel,
  resolveOpenAIModel,
} from '@ant/model-provider'
import { getConfiguredModel } from './configuredModels.js'
import { getAPIProvider, type APIProvider } from './providers.js'

/**
 * Resolve the exact model ID sent to the active provider.
 *
 * Models explicitly configured through /login always win over legacy
 * family aliases and environment-variable mappings. This guarantees that a
 * configured ID such as `claude-proxy-opus-custom` is sent unchanged.
 */
export function resolveProviderModelId(
  model: string,
  provider: APIProvider = getAPIProvider(),
): string {
  const configuredModel = getConfiguredModel(model)
  if (configuredModel) return configuredModel.id

  switch (provider) {
    case 'openai':
      return resolveOpenAIModel(model)
    case 'gemini':
      return resolveGeminiModel(model)
    case 'grok':
      return resolveGrokModel(model)
    default:
      return model
  }
}
