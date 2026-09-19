import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeProviderConfiguration } from '@proma/shared'
import { normalizeInitializedAgentRuntimeModelCatalog } from './model-catalog-fallback'

const configuration: AgentRuntimeProviderConfiguration = {
  modelType: 'openai',
  defaultModel: 'model-a',
  models: [
    { id: 'model-a', name: 'Configured A', contextWindow: 128_000 },
    { id: 'model-b', name: 'Configured B' },
  ],
}

describe('Local CLI initialize 模型目录', () => {
  test('Given initialize 返回模型能力 When 归一化 Then 仅采用 CLI 明确声明的能力', () => {
    const catalog = normalizeInitializedAgentRuntimeModelCatalog('channel-1', {
      models: [
        {
          value: 'model-a',
          displayName: 'Runtime A',
          description: 'Runtime description',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
          supportsFastMode: true,
          supportsAutoMode: false,
        },
        { value: 'model-b', displayName: 'Runtime B', description: '' },
      ],
    }, configuration)

    expect(catalog?.models[0]).toEqual({
      value: 'model-a',
      displayName: 'Runtime A',
      description: 'Runtime description',
      contextWindow: 128_000,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: false,
    })
    expect(catalog?.models[1]).toMatchObject({
      value: 'model-b',
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAdaptiveThinking: false,
      supportsFastMode: false,
      supportsAutoMode: false,
    })
    expect(catalog?.contextPolicy.autoCompactEnabled).toBe(false)
  })

  test('Given initialize 未返回模型 When 归一化 Then 拒绝把空响应伪装为 Runtime 目录', () => {
    expect(normalizeInitializedAgentRuntimeModelCatalog(
      'channel-1',
      { commands: [] },
      configuration,
    )).toBeUndefined()
  })

  test('Given initialize 含 default 占位和重复模型 When 归一化 Then 跳过占位并稳定去重', () => {
    const catalog = normalizeInitializedAgentRuntimeModelCatalog('channel-1', {
      models: [
        { value: 'default', displayName: 'Default', description: '' },
        { value: 'model-a', displayName: 'A', description: '' },
        { value: 'model-a', displayName: 'Duplicate', description: '' },
      ],
    }, configuration)
    expect(catalog?.models.map(model => model.value)).toEqual(['model-a'])
  })
})
