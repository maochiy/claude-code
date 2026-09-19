import { describe, expect, test } from 'bun:test'
import { resolveOpenAIProtocol } from '../protocol.js'

describe('resolveOpenAIProtocol', () => {
  test('uses the explicit provider protocol without model or URL inference', () => {
    expect(resolveOpenAIProtocol('openai-responses', undefined)).toBe(
      'responses',
    )
    expect(resolveOpenAIProtocol('openai-responses-oauth', undefined)).toBe(
      'responses-oauth',
    )
    expect(resolveOpenAIProtocol('openai', undefined)).toBe('chat-completions')
  })

  test('keeps legacy ChatGPT login compatible', () => {
    expect(resolveOpenAIProtocol('openai', 'chatgpt')).toBe('responses-oauth')
  })
})
