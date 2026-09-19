import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import {
  buildLocalCliProviderConfiguration,
  buildLocalCliProviderEnvironment,
  buildLocalCliProviderSettings,
  resolveLocalCliModelType,
} from './provider-configuration'

function channel(provider: Channel['provider'] = 'anthropic'): Channel {
  return {
    id: `channel-${provider}`,
    name: '测试渠道',
    provider,
    baseUrl: '',
    apiKey: 'encrypted',
    models: [
      {
        id: 'model-a',
        name: 'Model A',
        description: 'Primary model',
        contextWindow: 128_000,
        thinkingEffortLevels: ['low', 'high'],
        enabled: true,
      },
      { id: 'model-disabled', name: 'Disabled', enabled: false },
    ],
    defaultModelId: 'model-a',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Local CLI provider 配置', () => {
  test('Given Proma 渠道 When 生成 providerConfiguration 与 settings Then 只包含启用模型且不包含凭据', () => {
    const configuration = buildLocalCliProviderConfiguration(channel(), 'model-a')
    expect(configuration).toEqual({
      modelType: 'anthropic',
      defaultModel: 'model-a',
      models: [{
        id: 'model-a',
        name: 'Model A',
        description: 'Primary model',
        contextWindow: 128_000,
        effortLevels: ['low', 'high'],
      }],
    })
    expect(buildLocalCliProviderSettings(configuration)).toEqual({
      modelType: 'anthropic',
      model: 'model-a',
      models: configuration.models,
    })
    expect(buildLocalCliProviderSettings(configuration)).not.toHaveProperty('apiKey')
  })

  test('Given 请求模型未启用 When 生成配置 Then 明确拒绝而不把未知模型塞入目录', () => {
    expect(() => buildLocalCliProviderConfiguration(channel(), 'unknown-model'))
      .toThrow('模型「unknown-model」未在渠道「测试渠道」中启用')
  })

  test('Given Responses 或 OAuth Responses 渠道 When 映射 CLI Then 保留显式协议且不降级成 Chat Completions', () => {
    expect(resolveLocalCliModelType('openai-responses')).toBe('openai-responses')
    expect(resolveLocalCliModelType('openai-codex')).toBe('openai-responses-oauth')
  })
})

describe('Local CLI provider 环境', () => {
  test('Given OpenAI Chat 渠道 When 构建环境 Then 锁定 Host 路由并规范化 endpoint', () => {
    expect(buildLocalCliProviderEnvironment({
      provider: 'custom',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
      modelId: 'model-a',
      userAgent: 'Proma/test',
      autoCompactRatio: 72.5,
    })).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://gateway.example.com/v1',
      OPENAI_MODEL: 'model-a',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '72.5',
    })
  })

  test('Given OpenAI Responses 渠道 When 构建环境 Then 规范化 Responses endpoint 且保留 API Key 认证', () => {
    expect(buildLocalCliProviderEnvironment({
      provider: 'openai-responses',
      apiKey: 'responses-secret',
      baseUrl: 'https://api.openai.com/v1/responses',
      modelId: 'gpt-test',
      userAgent: 'Proma/test',
    })).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'responses-secret',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-test',
    })
  })

  test('Given OAuth Responses 渠道 When 构建环境 Then 只传当前 access 和 accountId', () => {
    const environment = buildLocalCliProviderEnvironment({
      provider: 'openai-codex',
      apiKey: 'oauth-access',
      modelId: 'gpt-test',
      userAgent: 'Proma/test',
      codexCredentials: {
        access: 'oauth-access',
        refresh: 'oauth-refresh',
        expires: 999_999,
        accountId: 'account-test',
      },
    })
    expect(environment).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_AUTH_MODE: 'host',
      OPENAI_CHATGPT_ACCESS_TOKEN: 'oauth-access',
      OPENAI_CHATGPT_ACCOUNT_ID: 'account-test',
      OPENAI_MODEL: 'gpt-test',
    })
    expect(Object.values(environment)).not.toContain('oauth-refresh')
  })

  test('Given Anthropic Bearer 渠道 When 构建环境 Then 使用对应认证且锁定 Host 路由', () => {
    const environment = buildLocalCliProviderEnvironment({
      provider: 'kimi-coding',
      apiKey: 'secret',
      baseUrl: 'https://api.kimi.com/coding/v1/messages',
      modelId: 'kimi-k2',
      userAgent: 'Proma/test',
    })
    expect(environment).toMatchObject({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding',
      ANTHROPIC_MODEL: 'kimi-k2',
    })
    expect(environment.OPENAI_API_KEY).toBeUndefined()
  })

  test('Given provider 协议清单 When 映射 Then 只以 Runtime API mode 决定 CLI modelType', () => {
    expect(resolveLocalCliModelType('anthropic-compatible')).toBe('anthropic')
    expect(resolveLocalCliModelType('openai')).toBe('openai')
    expect(resolveLocalCliModelType('openai-responses')).toBe('openai-responses')
    expect(resolveLocalCliModelType('openai-codex')).toBe('openai-responses-oauth')
    expect(resolveLocalCliModelType('google')).toBe('gemini')
  })

  test('Given 用户显式把自动压缩占比设为 0 When 构建环境 Then 关闭 CLI 自动压缩', () => {
    const environment = buildLocalCliProviderEnvironment({
      provider: 'anthropic',
      apiKey: 'secret',
      autoCompactRatio: 0,
      userAgent: 'Proma/test',
    })
    expect(environment.DISABLE_AUTO_COMPACT).toBe('1')
    expect(environment.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined()
  })
})
