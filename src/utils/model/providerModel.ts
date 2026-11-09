import {
  resolveGeminiModel,
  resolveGrokModel,
  resolveOpenAIModel,
} from '@ant/model-provider'
import {
  isChatGPTAuthMode,
  resolveChatGPTCodexModelForTier,
} from './chatgptModels.js'
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
  // OAuth is a separate backend, not an OpenAI-compatible endpoint. Never
  // remap a selected GPT model through stale API-key/GLM environment settings.
  if (provider === 'openai' && isChatGPTAuthMode()) {
    const cleanModel = model.replace(/\[1m\]$/i, '')
    if (
      cleanModel === 'opus' ||
      cleanModel === 'sonnet' ||
      cleanModel === 'haiku'
    ) {
      return resolveChatGPTCodexModelForTier({
        tier: cleanModel,
        isChatGPTAuth: true,
      })!
    }
    // Do not freeze OAuth support to the picker catalog: newer GPT/Codex
    // IDs may be usable before we ship a picker update.
    if (!/^(?:gpt-|codex(?:-|$))/i.test(cleanModel)) {
      throw new Error(
        `ChatGPT OAuth cannot use model '${model}'. Select a Codex GPT model with /model, or use an API-key provider for this model. Check OPENAI_MODEL, CLAUDE_CODE_SUBAGENT_MODEL and saved model settings.`,
      )
    }
    return cleanModel
  }

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
