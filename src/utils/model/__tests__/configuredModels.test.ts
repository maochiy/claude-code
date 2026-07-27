import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getContextWindowForModel } from '../../context.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
} from '../../effort.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../settings/settingsCache.js'
import {
  getInitialConfiguredModels,
  normalizeConfiguredModels,
  resolveConfiguredDefaultModelId,
} from '../configuredModels.js'
import {
  getDefaultHaikuModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  parseUserSpecifiedModel,
} from '../model.js'
import { getModelOptions } from '../modelOptions.js'
import { resolveProviderModelId } from '../providerModel.js'

const savedEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_DEFAULT_HAIKU_MODEL: process.env.OPENAI_DEFAULT_HAIKU_MODEL,
  OPENAI_DEFAULT_SONNET_MODEL: process.env.OPENAI_DEFAULT_SONNET_MODEL,
  OPENAI_DEFAULT_OPUS_MODEL: process.env.OPENAI_DEFAULT_OPUS_MODEL,
}

function setSettings(settings: Record<string, unknown>): void {
  resetSettingsCache()
  setSessionSettingsCache({
    settings,
    errors: [],
  })
}

describe('configured model catalog', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_DEFAULT_HAIKU_MODEL
    delete process.env.OPENAI_DEFAULT_SONNET_MODEL
    delete process.env.OPENAI_DEFAULT_OPUS_MODEL
    setSettings({})
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setSettings({})
  })

  test('normalizes legacy 1m suffix and deduplicates model IDs', () => {
    expect(
      normalizeConfiguredModels([
        { id: 'glm-5.2[1m]' },
        { id: 'glm-5.2', name: 'GLM 5.2' },
        { id: 'deepseek-v4-pro' },
      ]),
    ).toEqual([
      {
        id: 'glm-5.2',
        name: 'GLM 5.2',
        contextWindow: 1_000_000,
      },
      { id: 'deepseek-v4-pro' },
    ])
  })

  test('loads more than three configured models', () => {
    const models = Array.from({ length: 6 }, (_, index) => ({
      id: `model-${index + 1}`,
    }))
    expect(
      getInitialConfiguredModels('openai', {
        modelType: 'openai',
        models,
      }),
    ).toHaveLength(6)
  })

  test('migrates the legacy alias default to its exact model ID', () => {
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'gpt-5.6-luna'
    const models = [{ id: 'glm-5.2' }, { id: 'gpt-5.6-luna' }]
    expect(
      resolveConfiguredDefaultModelId('openai', models, {
        modelType: 'openai',
        model: 'opus',
      }),
    ).toBe('gpt-5.6-luna')
  })

  test('uses the configured default for legacy internal model roles', () => {
    setSettings({
      modelType: 'openai',
      model: 'Model-With-Case',
      models: [
        { id: 'Model-With-Case', name: 'Primary' },
        { id: 'secondary-model' },
      ],
    })

    expect(getDefaultHaikuModel()).toBe('Model-With-Case')
    expect(getDefaultSonnetModel()).toBe('Model-With-Case')
    expect(getDefaultOpusModel()).toBe('Model-With-Case')
    expect(parseUserSpecifiedModel('Model-With-Case')).toBe('Model-With-Case')
  })

  test('builds model picker options from every configured model', () => {
    setSettings({
      modelType: 'openai',
      model: 'model-a',
      models: [
        { id: 'model-a', name: 'Model A', description: 'First model' },
        { id: 'model-b', contextWindow: 1_000_000 },
        { id: 'model-c', effortLevels: ['low', 'high'] },
        { id: 'model-d' },
      ],
    })

    expect(getModelOptions().map(option => option.value)).toEqual([
      'model-a',
      'model-b',
      'model-c',
      'model-d',
    ])
  })

  test('uses configured context window and effort levels', () => {
    setSettings({
      modelType: 'openai',
      model: 'reasoning-model',
      models: [
        {
          id: 'reasoning-model',
          contextWindow: 1_000_000,
          effortLevels: ['low', 'high'],
        },
      ],
    })

    expect(getContextWindowForModel('reasoning-model')).toBe(1_000_000)
    expect(modelSupportsEffort('reasoning-model')).toBe(true)
    expect(modelSupportsMaxEffort('reasoning-model')).toBe(false)
    expect(resolveAppliedEffort('reasoning-model', 'high')).toBe('high')
    expect(resolveAppliedEffort('reasoning-model', 'medium')).toBeUndefined()
  })

  test('an empty effort level array disables the effort parameter', () => {
    setSettings({
      modelType: 'openai',
      model: 'no-effort-model',
      models: [{ id: 'no-effort-model', effortLevels: [] }],
    })

    expect(modelSupportsEffort('no-effort-model')).toBe(false)
    expect(resolveAppliedEffort('no-effort-model', 'high')).toBeUndefined()
  })

  test('sends an explicitly configured provider model ID unchanged', () => {
    process.env.OPENAI_MODEL = 'legacy-global-override'
    setSettings({
      modelType: 'openai',
      model: 'claude-proxy-opus-custom',
      models: [{ id: 'claude-proxy-opus-custom' }],
    })

    expect(resolveProviderModelId('claude-proxy-opus-custom', 'openai')).toBe(
      'claude-proxy-opus-custom',
    )
  })
})
