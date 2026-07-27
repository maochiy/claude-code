import { afterEach, describe, expect, test } from 'bun:test'
import { resolveDesktopModelCatalog } from './modelCatalog.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('Desktop Runtime 模型目录', () => {
  test('Proma 配置的模型集合决定目录，模型能力仍由 CCB 内核解析', () => {
    const catalog = resolveDesktopModelCatalog(
      {
        variables: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'private-reasoner',
        },
        configDir: '/tmp/ccb-model-catalog-test',
      },
      {
        modelType: 'openai',
        defaultModel: 'private-reasoner',
        models: [
          {
            id: 'private-reasoner',
            name: 'Private Reasoner',
            effortLevels: ['low', 'high'],
          },
        ],
      },
    )

    expect(catalog.defaultModel).toBe('private-reasoner')
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0]?.value).toBe('private-reasoner')
    expect(catalog.models[0]?.displayName).toBe('Private Reasoner')
    expect(catalog.models[0]?.supportsEffort).toBe(true)
    expect(catalog.models[0]?.supportedEffortLevels).toEqual(['low', 'high'])
  })

  test('模型 ID 的 1M 标记由 CCB 配置解析并返回真实上下文窗口', () => {
    const catalog = resolveDesktopModelCatalog(
      {
        variables: {
          ANTHROPIC_API_KEY: 'test-key',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]',
        },
        configDir: '/tmp/ccb-model-catalog-test',
      },
      {
        modelType: 'anthropic',
        defaultModel: 'claude-sonnet-4-6[1m]',
        models: [
          {
            id: 'claude-sonnet-4-6[1m]',
            name: 'Claude Sonnet 4.6 1M',
          },
        ],
      },
    )

    expect(catalog.defaultModel).toBe('claude-sonnet-4-6')
    expect(catalog.models[0]?.value).toBe('claude-sonnet-4-6')
    expect(catalog.models[0]?.contextWindow).toBe(1_000_000)
  })
})
