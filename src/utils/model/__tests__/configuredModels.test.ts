import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../../../bootstrap/state.js'
import { getAgentModel } from '../agent.js'
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
  getMainLoopModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  modelDisplayString,
  parseUserSpecifiedModel,
  renderModelName,
} from '../model.js'
import { getModelOptions } from '../modelOptions.js'
import { resolveProviderModelId } from '../providerModel.js'

const savedEnv = {
  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
  OPENAI_AUTH_MODE: process.env.OPENAI_AUTH_MODE,
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
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    delete process.env.OPENAI_AUTH_MODE
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

  test('keeps a session model override when shared settings change', () => {
    const previous = getMainLoopModelOverride()
    try {
      setSettings({ modelType: 'openai', model: 'glm-5.3-flashx' })
      setMainLoopModelOverride('gpt-6.1-sol')
      setSettings({ modelType: 'openai', model: 'another-session-model' })
      expect(getMainLoopModel()).toBe('gpt-6.1-sol')
      expect(getAgentModel('inherit', getMainLoopModel())).toBe('gpt-6.1-sol')
    } finally {
      setMainLoopModelOverride(previous)
    }
  })

  test('pins the initial saved model across shared settings reloads', () => {
    const previous = getMainLoopModelOverride()
    try {
      setMainLoopModelOverride(undefined)
      setSettings({ modelType: 'openai', model: 'gpt-6.1-sol' })
      expect(getMainLoopModel()).toBe('gpt-6.1-sol')
      setSettings({ modelType: 'openai', model: 'glm-5.3-flashx' })
      expect(getMainLoopModel()).toBe('gpt-6.1-sol')
    } finally {
      setMainLoopModelOverride(previous)
    }
  })

  test('pins the concrete model when a configured alias changes', () => {
    const previous = getMainLoopModelOverride()
    try {
      setMainLoopModelOverride(undefined)
      setSettings({
        modelType: 'openai',
        model: 'opus',
        models: [{ id: 'gpt-first' }],
      })
      expect(getMainLoopModel()).toBe('gpt-first')
      setSettings({
        modelType: 'openai',
        model: 'opus',
        models: [{ id: 'gpt-second' }],
      })
      expect(getMainLoopModel()).toBe('gpt-first')
    } finally {
      setMainLoopModelOverride(previous)
    }
  })

  test('does not replace an explicit session or agent model with OPENAI_MODEL', () => {
    process.env.OPENAI_MODEL = 'glm-5.3-flashx'
    expect(resolveProviderModelId('gpt-6.1-sol', 'openai')).toBe('gpt-6.1-sol')
    expect(resolveProviderModelId('gpt-5.6-luna', 'openai')).toBe(
      'gpt-5.6-luna',
    )
  })

  test('rejects stale GLM configuration before the Codex OAuth request', () => {
    const previous = process.env.OPENAI_AUTH_MODE
    try {
      process.env.OPENAI_AUTH_MODE = 'chatgpt'
      process.env.OPENAI_MODEL = 'glm-5.3-flashx'
      setSettings({
        modelType: 'openai',
        models: [{ id: 'glm-5.3-flashx' }],
      })
      expect(() => resolveProviderModelId('glm-5.3-flashx', 'openai')).toThrow(
        'ChatGPT OAuth cannot use model',
      )
      expect(resolveProviderModelId('gpt-6.1-sol', 'openai')).toBe(
        'gpt-6.1-sol',
      )
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-flashx'
      const agentModel = getAgentModel('inherit', 'gpt-6.1-sol')
      expect(agentModel).toBe('glm-5.3-flashx')
      expect(() => resolveProviderModelId(agentModel, 'openai')).toThrow(
        'CLAUDE_CODE_SUBAGENT_MODEL',
      )
      expect(resolveProviderModelId('gpt-future-model', 'openai')).toBe(
        'gpt-future-model',
      )
    } finally {
      if (previous === undefined) delete process.env.OPENAI_AUTH_MODE
      else process.env.OPENAI_AUTH_MODE = previous
    }
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

describe('renderModelName with configured model catalog', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    delete process.env.OPENAI_MODEL
    setSettings({})
  })

  afterEach(() => {
    setSettings({})
  })

  test('Given a configured model with name, when rendering, then the name is shown instead of the id', () => {
    setSettings({
      models: [
        { id: 'zmn/zmn-flash', name: 'glm-5.3-flash', contextWindow: 1000000 },
      ],
    })
    expect(renderModelName('zmn/zmn-flash')).toBe('glm-5.3-flash')
  })

  test('Given a configured model without name, when rendering, then the id is shown', () => {
    setSettings({
      models: [{ id: 'zmn/zmn-flash' }],
    })
    expect(renderModelName('zmn/zmn-flash')).toBe('zmn/zmn-flash')
  })

  test('Given no configured catalog, when rendering an unknown model, then the id is shown', () => {
    setSettings({})
    expect(renderModelName('zmn/zmn-flash')).toBe('zmn/zmn-flash')
  })

  test('modelDisplayString prefers the configured name for the resolved model', () => {
    setSettings({
      models: [{ id: 'zmn/zmn-flash', name: 'glm-5.3-flash' }],
    })
    expect(modelDisplayString('zmn/zmn-flash')).toBe('glm-5.3-flash')
  })
})
