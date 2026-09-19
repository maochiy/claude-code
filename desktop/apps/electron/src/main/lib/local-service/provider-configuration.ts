import { normalizeAnthropicBaseUrlForSdk } from '@proma/core'
import {
  extractZhipuCodingTeamApiToken,
  type AgentRuntimeProviderConfiguration,
  type Channel,
  type CodexOAuthCredentials,
  type ProviderType,
} from '@proma/shared'
import { resolvePromaRuntimeApiMode } from '../runtime/proma-runtime-api-mode'

const ANTHROPIC_BEARER_PROVIDERS: ReadonlySet<ProviderType> = new Set([
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'xiaomi-token-plan',
  'qwen-token-plan',
  'minimax',
])

export interface LocalCliProviderSettings {
  modelType: AgentRuntimeProviderConfiguration['modelType']
  model?: string
  models: AgentRuntimeProviderConfiguration['models']
}

export interface BuildLocalCliProviderEnvironmentInput {
  provider: ProviderType
  apiKey: string
  baseUrl?: string
  modelId?: string
  userAgent: string
  /** ChatGPT OAuth 凭据由 Main 刷新后按最小范围传给本次 CLI Session。 */
  codexCredentials?: CodexOAuthCredentials
  /** 用户显式配置的自动压缩占比；缺失时完全交由 CLI 默认策略。 */
  autoCompactRatio?: number
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeOpenAIBaseUrl(value: string): string {
  return trimTrailingSlash(value)
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
}

function normalizeGeminiBaseUrl(value: string): string {
  const normalized = trimTrailingSlash(value)
  return /\/v\d+(?:beta)?$/i.test(normalized)
    ? normalized
    : `${normalized}/v1beta`
}

/**
 * CLI 的 providerConfiguration 显式区分 Messages、Chat Completions、
 * Responses、OAuth Responses 和 Gemini。
 * 协议完全取自 Proma Runtime route；禁止根据 URL、模型名或凭据内容猜测。
 */
export function resolveLocalCliModelType(
  provider: ProviderType,
): AgentRuntimeProviderConfiguration['modelType'] {
  const apiMode = resolvePromaRuntimeApiMode(provider)
  switch (apiMode) {
    case 'anthropic_messages':
      return 'anthropic'
    case 'openai_chat_completions':
      return 'openai'
    case 'google_generative_language':
      return 'gemini'
    case 'openai_responses':
      return 'openai-responses'
    case 'openai_responses_oauth':
      return 'openai-responses-oauth'
  }
}

/** 将 Proma 渠道的显式模型目录转换为 CLI providerConfiguration。 */
export function buildLocalCliProviderConfiguration(
  channel: Channel,
  defaultModel?: string,
  options: { includeDisabledModels?: boolean } = {},
): AgentRuntimeProviderConfiguration {
  const modelType = resolveLocalCliModelType(channel.provider)
  const models = channel.models
    .filter(model => options.includeDisabledModels || model.enabled)
    .map(model => ({
      id: model.id,
      name: model.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.thinkingEffortLevels !== undefined
        ? { effortLevels: [...model.thinkingEffortLevels] }
        : {}),
    }))

  if (models.length === 0) {
    throw new Error(`渠道「${channel.name}」没有启用的模型`)
  }

  const requestedModel = defaultModel?.trim()
  if (requestedModel && !models.some(model => model.id === requestedModel)) {
    throw new Error(`模型「${requestedModel}」未在渠道「${channel.name}」中启用`)
  }
  const channelDefault = channel.defaultModelId
    && models.some(model => model.id === channel.defaultModelId)
      ? channel.defaultModelId
      : undefined
  const resolvedDefault = requestedModel || channelDefault || models[0]?.id

  return {
    modelType,
    ...(resolvedDefault ? { defaultModel: resolvedDefault } : {}),
    models,
  }
}

/** 转为 CLI `--settings` 接受的 JSON；配置中不包含任何凭据。 */
export function buildLocalCliProviderSettings(
  configuration: AgentRuntimeProviderConfiguration,
): LocalCliProviderSettings {
  return {
    modelType: configuration.modelType,
    ...(configuration.defaultModel ? { model: configuration.defaultModel } : {}),
    models: configuration.models.map(model => ({
      ...model,
      ...(model.effortLevels ? { effortLevels: [...model.effortLevels] } : {}),
    })),
  }
}

/**
 * 为宿主管理的非原生渠道构建 CLI 进程环境。
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 防止用户 settings.env 改写本次会话路由。
 */
export function buildLocalCliProviderEnvironment(
  input: BuildLocalCliProviderEnvironmentInput,
): Record<string, string> {
  const apiMode = resolvePromaRuntimeApiMode(input.provider)
  // 在写入任何 provider 环境前先验证 CLI 是否支持该协议。
  resolveLocalCliModelType(input.provider)
  const environment: Record<string, string> = {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  }
  if (input.autoCompactRatio !== undefined && Number.isFinite(input.autoCompactRatio)) {
    const ratio = Math.min(100, Math.max(0, input.autoCompactRatio))
    if (ratio === 0) {
      environment.DISABLE_AUTO_COMPACT = '1'
    } else {
      environment.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(ratio)
    }
  }

  if (apiMode === 'google_generative_language') {
    environment.CLAUDE_CODE_USE_GEMINI = '1'
    environment.GEMINI_API_KEY = input.apiKey
    if (input.baseUrl) environment.GEMINI_BASE_URL = normalizeGeminiBaseUrl(input.baseUrl)
    if (input.modelId) environment.GEMINI_MODEL = input.modelId
    return environment
  }

  if (apiMode === 'openai_chat_completions' || apiMode === 'openai_responses') {
    environment.CLAUDE_CODE_USE_OPENAI = '1'
    environment.OPENAI_API_KEY = input.apiKey
    if (input.baseUrl) environment.OPENAI_BASE_URL = normalizeOpenAIBaseUrl(input.baseUrl)
    if (input.modelId) environment.OPENAI_MODEL = input.modelId
    return environment
  }

  if (apiMode === 'openai_responses_oauth') {
    const credentials = input.codexCredentials
    environment.CLAUDE_CODE_USE_OPENAI = '1'
    environment.OPENAI_AUTH_MODE = 'host'
    environment.OPENAI_CHATGPT_ACCESS_TOKEN = credentials?.access ?? input.apiKey
    if (credentials?.accountId) {
      environment.OPENAI_CHATGPT_ACCOUNT_ID = credentials.accountId
    }
    if (input.modelId) environment.OPENAI_MODEL = input.modelId
    return environment
  }

  if (ANTHROPIC_BEARER_PROVIDERS.has(input.provider)) {
    environment.ANTHROPIC_AUTH_TOKEN = input.provider === 'zhipu-coding-team'
      ? extractZhipuCodingTeamApiToken(input.apiKey)
      : input.apiKey
    if (input.provider !== 'minimax') {
      environment.ANTHROPIC_CUSTOM_HEADERS = `User-Agent: ${input.userAgent}`
    }
  } else {
    environment.ANTHROPIC_API_KEY = input.apiKey
  }
  if (input.baseUrl) {
    environment.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrlForSdk(input.baseUrl)
  }
  if (input.modelId) environment.ANTHROPIC_MODEL = input.modelId
  return environment
}
