import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SettingsJson } from 'src/utils/settings/types.js'

// In-memory settings store standing in for the real file-backed settings.
// updateSettingsForSource semantics are replicated: deep merge, arrays
// replace, explicit undefined deletes.
let settingsStore: SettingsJson = {}

function deepMergeInPlace(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key]
      continue
    }
    if (Array.isArray(value)) {
      target[key] = value
      continue
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      deepMergeInPlace(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      continue
    }
    target[key] = value
  }
}

mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => settingsStore,
  updateSettingsForSource: (_source: string, settings: SettingsJson) => {
    deepMergeInPlace(
      settingsStore as unknown as Record<string, unknown>,
      settings as unknown as Record<string, unknown>,
    )
    return { error: null }
  },
}))

import {
  activateProviderProfile,
  getActiveProviderProfileType,
  getActiveProviderProfileName,
  getConfiguredProviderProfiles,
  getProviderProfile,
  saveProviderProfile,
} from '../providerProfiles.js'
import { getInactiveProviderOptions } from '../modelOptions.js'

function setSettings(settings: SettingsJson): void {
  settingsStore = settings
}

const savedEnv = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_AUTH_MODE: process.env.OPENAI_AUTH_MODE,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
}

describe('providerProfiles', () => {
  beforeEach(() => {
    for (const key of Object.keys(savedEnv)) {
      delete process.env[key]
    }
    setSettings({})
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setSettings({})
  })

  test('activating a provider preserves the previous provider in its profile', () => {
    setSettings({
      modelType: 'anthropic',
      model: 'glm-5.2',
      models: [{ id: 'glm-5.2', name: 'GLM' }],
      env: {
        ANTHROPIC_BASE_URL: 'https://api.xiuda.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-xiuda',
      },
      providers: {
        openai: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [{ id: 'deepseek-chat' }],
          defaultModel: 'deepseek-chat',
        },
      },
    })

    const { error } = activateProviderProfile('openai')
    expect(error).toBe(null)

    // Top-level fields switched to openai
    expect(settingsStore.modelType).toBe('openai')
    expect(settingsStore.model).toBe('deepseek-chat')
    expect(settingsStore.models).toEqual([{ id: 'deepseek-chat' }])
    expect(settingsStore.env?.OPENAI_BASE_URL).toBe(
      'https://api.deepseek.com/v1',
    )
    expect(settingsStore.env?.OPENAI_API_KEY).toBe('sk-ds')
    // Previous provider's env keys removed from settings.env
    expect(settingsStore.env?.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(settingsStore.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

    // Previous provider snapshotted into its profile — nothing lost
    const anthropic = settingsStore.providers?.anthropic
    expect(anthropic?.baseUrl).toBe('https://api.xiuda.com')
    expect(anthropic?.apiKey).toBe('sk-xiuda')
    expect(anthropic?.models).toEqual([{ id: 'glm-5.2', name: 'GLM' }])
    expect(anthropic?.defaultModel).toBe('glm-5.2')

    // process.env patched for the new provider
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  test('switching back restores the snapshotted provider', () => {
    setSettings({
      modelType: 'anthropic',
      model: 'glm-5.2',
      models: [{ id: 'glm-5.2' }],
      env: {
        ANTHROPIC_BASE_URL: 'https://api.xiuda.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-xiuda',
      },
      providers: {
        openai: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [{ id: 'deepseek-chat' }],
          defaultModel: 'deepseek-chat',
        },
      },
    })

    activateProviderProfile('openai')
    const { error } = activateProviderProfile('anthropic')
    expect(error).toBe(null)

    expect(settingsStore.modelType).toBe('anthropic')
    expect(settingsStore.model).toBe('glm-5.2')
    expect(settingsStore.models).toEqual([{ id: 'glm-5.2' }])
    expect(settingsStore.env?.ANTHROPIC_BASE_URL).toBe('https://api.xiuda.com')
    expect(settingsStore.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-xiuda')
    // openai env keys cleared when leaving openai
    expect(settingsStore.env?.OPENAI_BASE_URL).toBeUndefined()
    expect(settingsStore.env?.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('ChatGPT auth mode maps to OPENAI_AUTH_MODE and clears key/url env', () => {
    setSettings({
      modelType: 'anthropic',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-xiuda' },
      providers: {
        openai: { authMode: 'chatgpt' },
      },
    })

    const { error } = activateProviderProfile('openai')
    expect(error).toBe(null)

    expect(settingsStore.modelType).toBe('openai')
    expect(settingsStore.env?.OPENAI_AUTH_MODE).toBe('chatgpt')
    expect(settingsStore.env?.OPENAI_BASE_URL).toBeUndefined()
    expect(settingsStore.env?.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_AUTH_MODE).toBe('chatgpt')
  })

  test('shell-exported env vars of other providers are left alone', () => {
    process.env.GEMINI_API_KEY = 'from-shell'
    setSettings({
      modelType: 'anthropic',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-xiuda' },
      providers: {
        openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' },
      },
    })

    activateProviderProfile('openai')
    // settings-managed keys are patched, shell-only keys untouched
    expect(process.env.GEMINI_API_KEY).toBe('from-shell')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
  })

  test('shell-exported config of an inactive provider is discoverable', () => {
    process.env.OPENAI_API_KEY = 'sk-shell'
    process.env.OPENAI_BASE_URL = 'https://api.shell.example.com'
    setSettings({
      modelType: 'anthropic',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-xiuda' },
    })

    const profile = getProviderProfile('openai')
    expect(profile?.apiKey).toBe('sk-shell')
    expect(profile?.baseUrl).toBe('https://api.shell.example.com')

    const types = getConfiguredProviderProfiles().map(p => p.type)
    expect(types).toContain('openai')
    expect(types).toContain('anthropic')
  })

  test('getProviderProfile falls back to legacy flattened config for the active provider', () => {
    setSettings({
      modelType: 'openai',
      model: 'deepseek-chat',
      models: [{ id: 'deepseek-chat' }],
      env: {
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_API_KEY: 'sk-ds',
      },
    })

    const profile = getProviderProfile('openai')
    expect(profile?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(profile?.apiKey).toBe('sk-ds')
    expect(profile?.models).toEqual([{ id: 'deepseek-chat' }])
    expect(getProviderProfile('gemini')).toBeUndefined()
  })

  test('saveProviderProfile merges without touching top-level activation state', () => {
    setSettings({
      modelType: 'anthropic',
      providers: {
        openai: { baseUrl: 'https://old.example.com' },
      },
    })

    saveProviderProfile('openai', { apiKey: 'sk-new' })
    expect(settingsStore.providers?.openai?.baseUrl).toBe(
      'https://old.example.com',
    )
    expect(settingsStore.providers?.openai?.apiKey).toBe('sk-new')
    expect(settingsStore.modelType).toBe('anthropic')
  })

  test('getConfiguredProviderProfiles lists every provider with usable config', () => {
    setSettings({
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'sk-ds', OPENAI_BASE_URL: 'https://x' },
      providers: {
        anthropic: { baseUrl: 'https://api.xiuda.com', apiKey: 'sk-xiuda' },
        gemini: { baseUrl: 'https://generativelanguage.googleapis.com' }, // no key → not configured
      },
    })

    const types = getConfiguredProviderProfiles().map(p => p.type)
    expect(types).toContain('anthropic')
    expect(types).toContain('openai')
    expect(types).not.toContain('gemini')
  })

  test('getInactiveProviderOptions namespaces other providers and hides the active one', () => {
    setSettings({
      modelType: 'anthropic',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-xiuda' },
      providers: {
        openai: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          defaultModel: 'deepseek-chat',
        },
      },
    })

    const options = getInactiveProviderOptions()
    const values = options.map(o => String(o.value))
    expect(values).toContain('openai::default')
    expect(values).toContain('openai::deepseek-chat')
    // No anthropic catalog options for the active provider, but the
    // first-party escape hatch is allowed.
    expect(values.filter(v => v.startsWith('firstparty::'))).toEqual([
      'firstparty::firstparty',
    ])
    expect(values.filter(v => v.startsWith('anthropic::'))).toEqual([])
  })

  test('custom-named profiles surface under their own group', () => {
    setSettings({
      modelType: 'anthropic',
      activeProvider: 'xiuda',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-xiuda' },
      providers: {
        xiuda: {
          type: 'anthropic',
          baseUrl: 'https://api.xiuda.com',
          apiKey: 'sk-xiuda',
          models: [{ id: 'glm-5.3-flashx', name: 'GLM 5.3 FlashX' }],
          defaultModel: 'glm-5.3-flashx',
        },
        codex: { type: 'openai', authMode: 'chatgpt' },
        'glm-pool': {
          type: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [{ id: 'deepseek-chat' }],
          defaultModel: 'deepseek-chat',
        },
      },
    })

    expect(getActiveProviderProfileName()).toBe('xiuda')

    const profiles = getConfiguredProviderProfiles()
    const names = profiles.map(p => p.name)
    expect(names).toContain('xiuda')
    expect(names).toContain('codex')
    expect(names).toContain('glm-pool')

    // Active profile (xiuda) is excluded from the inactive groups; the other
    // two appear under their own names.
    const options = getInactiveProviderOptions()
    const groups = [...new Set(options.map(o => o.group))]
    expect(groups).toContain('codex · ChatGPT (Codex)')
    expect(groups).toContain('glm-pool')
    expect(groups).not.toContain('xiuda')
    expect(
      options.some(o => String(o.value) === 'glm-pool::deepseek-chat'),
    ).toBe(true)
    expect(options.some(o => String(o.value) === 'codex::default')).toBe(true)
  })

  test('activating a custom-named profile writes its type and name', () => {
    setSettings({
      modelType: 'openai',
      activeProvider: 'codex',
      env: { OPENAI_AUTH_MODE: 'chatgpt' },
      providers: {
        codex: { type: 'openai', authMode: 'chatgpt' },
        xiuda: {
          type: 'anthropic',
          baseUrl: 'https://api.xiuda.com',
          apiKey: 'sk-xiuda',
          models: [{ id: 'glm-5.3-flashx' }],
          defaultModel: 'glm-5.3-flashx',
        },
      },
    })

    const { error } = activateProviderProfile('xiuda')
    expect(error).toBe(null)

    expect(settingsStore.modelType).toBe('anthropic')
    expect(settingsStore.activeProvider).toBe('xiuda')
    expect(settingsStore.model).toBe('glm-5.3-flashx')
    expect(settingsStore.env?.ANTHROPIC_BASE_URL).toBe('https://api.xiuda.com')
    expect(settingsStore.env?.OPENAI_AUTH_MODE).toBeUndefined()
    // Outgoing codex profile snapshotted under its own name
    expect(settingsStore.providers?.codex?.authMode).toBe('chatgpt')
    expect(process.env.OPENAI_AUTH_MODE).toBeUndefined()
  })

  test('getActiveProviderProfileType returns undefined for first-party', () => {
    expect(getActiveProviderProfileType({})).toBeUndefined()
    expect(getActiveProviderProfileType({ modelType: 'openai' })).toBe('openai')
  })
})
