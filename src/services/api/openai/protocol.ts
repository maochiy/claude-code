import type { SettingsJson } from '../../../utils/settings/types.js'

export type OpenAIProtocol =
  | 'chat-completions'
  | 'responses'
  | 'responses-oauth'

/** 协议只取自显式 modelType；旧 ChatGPT 登录保留兼容入口。 */
export function resolveOpenAIProtocol(
  modelType: SettingsJson['modelType'],
  authMode = process.env.OPENAI_AUTH_MODE,
): OpenAIProtocol {
  if (modelType === 'openai-responses') return 'responses'
  if (modelType === 'openai-responses-oauth') return 'responses-oauth'
  if (modelType === 'openai' && authMode === 'chatgpt') return 'responses-oauth'
  return 'chat-completions'
}
