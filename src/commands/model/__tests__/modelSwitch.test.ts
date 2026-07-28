import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import { checkModelSwitchCapacity } from '../modelSwitch.js'

function messagesWithUsage(totalTokens: number): Message[] {
  return [
    {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as Message,
  ]
}

describe('checkModelSwitchCapacity', () => {
  test('allows usage below the target context window', () => {
    expect(
      checkModelSwitchCapacity(
        'claude-haiku-4-5-20251001',
        messagesWithUsage(199_999),
      ).allowed,
    ).toBe(true)
  })

  test('allows usage equal to the target context window', () => {
    expect(
      checkModelSwitchCapacity(
        'claude-haiku-4-5-20251001',
        messagesWithUsage(200_000),
      ).allowed,
    ).toBe(true)
  })

  test('rejects usage above the target context window with compact guidance', () => {
    const result = checkModelSwitchCapacity(
      'claude-haiku-4-5-20251001',
      messagesWithUsage(200_001),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.message).toContain('200,001')
      expect(result.message).toContain('200,000-token context window')
      expect(result.message).toContain('/compact')
    }
  })

  test('allows switching to an explicitly extended context model', () => {
    expect(
      checkModelSwitchCapacity(
        'claude-sonnet-4-6[1m]',
        messagesWithUsage(200_001),
      ).allowed,
    ).toBe(true)
  })
})
