import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONTEXT_1M_BETA_HEADER } from '../../constants/betas.js'
import {
  getContextWindowForModel,
  getEffectiveCapabilityContextWindow,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from '../context.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalDisable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
const originalUserType = process.env.USER_TYPE

function cacheCapability(maxInputTokens: number): void {
  const configDir = join(tmpdir(), `context-window-${crypto.randomUUID()}`)
  mkdirSync(join(configDir, 'cache'), { recursive: true })
  writeFileSync(
    join(configDir, 'cache', 'model-capabilities.json'),
    JSON.stringify({
      models: [
        {
          id: 'claude-haiku-4-5-20251001',
          max_input_tokens: maxInputTokens,
        },
      ],
      timestamp: Date.now(),
    }),
  )
  process.env.CLAUDE_CONFIG_DIR = configDir
}

describe('getContextWindowForModel', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    delete process.env.USER_TYPE
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalDisable1m === undefined)
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = originalDisable1m
    if (originalUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = originalUserType
  })

  test('does not activate extended context from advertised capability', () => {
    cacheCapability(1_000_000)

    expect(getContextWindowForModel('claude-haiku-4-5-20251001')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
  })

  test('caps advertised capability at the default context window', () => {
    expect(getEffectiveCapabilityContextWindow(150_000)).toBe(150_000)
    expect(getEffectiveCapabilityContextWindow(1_000_000)).toBeUndefined()
  })

  test('honors explicit and beta extended context activation', () => {
    cacheCapability(1_000_000)

    expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
    expect(
      getContextWindowForModel('claude-sonnet-4-6', [CONTEXT_1M_BETA_HEADER]),
    ).toBe(1_000_000)
  })

  test('caps extended context when disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'

    expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
  })
})
