import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopModelCatalog } from './modelCatalog.js'

const ORIGINAL_ENV = { ...process.env }
const tempDirectories: string[] = []

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Desktop Runtime 模型目录', () => {
  test('未打开 Session 时先完成配置 Bootstrap，再由 CCB 内核解析模型目录', () => {
    process.env.NODE_ENV = 'production'
    const catalog = resolveDesktopModelCatalog(
      process.cwd(),
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
    expect(typeof catalog.contextPolicy.autoCompactEnabled).toBe('boolean')
    expect(catalog.contextPolicy.models).toHaveLength(1)
    expect(catalog.contextPolicy.models[0]?.model).toBe('private-reasoner')
    expect(
      catalog.contextPolicy.models[0]?.effectiveContextWindow,
    ).toBeGreaterThan(0)
    expect(
      catalog.contextPolicy.models[0]?.autoCompactThreshold,
    ).toBeLessThanOrEqual(
      catalog.contextPolicy.models[0]?.effectiveContextWindow ?? 0,
    )
  })

  test('模型 ID 的 1M 标记由 CCB 配置解析并返回真实上下文窗口', () => {
    const catalog = resolveDesktopModelCatalog(
      process.cwd(),
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
    expect(catalog.contextPolicy.models[0]?.contextWindow).toBe(1_000_000)
    expect(
      catalog.contextPolicy.models[0]?.effectiveContextWindow,
    ).toBeLessThan(1_000_000)
  })

  test('Desktop 显式传入模型目录时覆盖 CCB 用户原生目录', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ccb-desktop-models-'))
    tempDirectories.push(configDir)
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        modelType: 'openai',
        model: 'ccb-primary',
        models: [
          {
            id: 'ccb-primary',
            name: 'CCB Primary',
            contextWindow: 1_000_000,
          },
          {
            id: 'ccb-fast',
            name: 'CCB Fast',
            contextWindow: 200_000,
          },
        ],
      }),
    )

    const catalog = resolveDesktopModelCatalog(
      process.cwd(),
      {
        variables: {
          OPENAI_API_KEY: 'test-key',
        },
        configDir,
      },
      {
        modelType: 'openai',
        defaultModel: 'proma-fallback',
        models: [{ id: 'proma-fallback', name: 'Proma Fallback' }],
      },
    )

    expect(catalog.defaultModel).toBe('proma-fallback')
    expect(catalog.models.map(model => model.value)).toEqual(['proma-fallback'])
  })

  test('Desktop 未传入模型目录时保留 CCB 用户原生目录', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ccb-native-models-'))
    tempDirectories.push(configDir)
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        modelType: 'openai',
        model: 'ccb-primary',
        models: [
          {
            id: 'ccb-primary',
            name: 'CCB Primary',
            contextWindow: 1_000_000,
          },
          {
            id: 'ccb-fast',
            name: 'CCB Fast',
            contextWindow: 200_000,
          },
        ],
      }),
    )

    const catalog = resolveDesktopModelCatalog(
      process.cwd(),
      {
        variables: {},
        configDir,
      },
      {
        modelType: 'anthropic',
        models: [],
      },
    )

    expect(catalog.defaultModel).toBe('ccb-primary')
    expect(catalog.models.map(model => model.value)).toEqual([
      'ccb-primary',
      'ccb-fast',
    ])
  })
})
