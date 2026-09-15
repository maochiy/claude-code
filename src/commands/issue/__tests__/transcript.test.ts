/**
 * Tests for the /issue transcript summarizer.
 *
 * The bug this covers: the summarizer used to read `entry.role` / `entry.content`
 * from the top level of each JSONL line, but sessionStorage nests conversation
 * content under `message`. On a real session log that mismatch made every issue
 * body degenerate to "(no conversation content in log)" with zero errors.
 */
import { describe, expect, test } from 'bun:test'
import { summarizeTranscript } from '../transcript.js'

/** A conversation entry in the shape sessionStorage actually writes. */
function nested(role: 'user' | 'assistant', content: unknown): string {
  return JSON.stringify({ type: role, message: { role, content } })
}

function nestedText(role: 'user' | 'assistant', text: string): string {
  return nested(role, [{ type: 'text', text }])
}

describe('summarizeTranscript', () => {
  test('reads the nested message shape written by sessionStorage', () => {
    const result = summarizeTranscript([
      nestedText('user', 'fix the login bug'),
      nestedText('assistant', 'looking into it'),
    ])
    expect(result).toBe('[user] fix the login bug\n[assistant] looking into it')
  })

  test('accepts a string content payload', () => {
    const result = summarizeTranscript([nested('user', 'plain string')])
    expect(result).toBe('[user] plain string')
  })

  test('accepts the legacy top-level role/content shape', () => {
    const result = summarizeTranscript([
      JSON.stringify({ role: 'assistant', content: 'legacy shape' }),
    ])
    expect(result).toBe('[assistant] legacy shape')
  })

  test('skips non-conversation entries', () => {
    const result = summarizeTranscript([
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      nestedText('user', 'only real turn'),
    ])
    expect(result).toBe('[user] only real turn')
  })

  test('picks the first text block and ignores other block types', () => {
    const result = summarizeTranscript([
      nested('assistant', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        { type: 'text', text: 'after the tool call' },
      ]),
    ])
    expect(result).toBe('[assistant] after the tool call')
  })

  test('returns a placeholder when there are no conversation turns', () => {
    expect(summarizeTranscript([])).toBe('(no conversation content in log)')
    expect(
      summarizeTranscript([JSON.stringify({ type: 'system', content: 'x' })]),
    ).toBe('(no conversation content in log)')
  })

  test('skips malformed JSON lines', () => {
    const result = summarizeTranscript([
      '{not json',
      nestedText('user', 'survived'),
      '{"truncated":',
    ])
    expect(result).toBe('[user] survived')
  })

  test('truncates each snippet to 200 characters', () => {
    const long = 'x'.repeat(500)
    const result = summarizeTranscript([nestedText('user', long)])
    expect(result).toBe(`[user] ${'x'.repeat(200)}`)
  })

  test('keeps only the last maxTurns * 2 turns', () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      nestedText('user', `turn ${i}`),
    )
    const result = summarizeTranscript(lines, 2)
    expect(result.split('\n')).toEqual([
      '[user] turn 4',
      '[user] turn 5',
      '[user] turn 6',
      '[user] turn 7',
    ])
  })
})

describe('summarizeTranscript error collection', () => {
  const errorResult = (text: string) =>
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: [{ type: 'text', text }],
            is_error: true,
          },
        ],
      },
    })

  test('collects block-array tool_result errors', () => {
    const result = summarizeTranscript([errorResult('No such tool available')])
    expect(result).toBe(
      '(no conversation content in log)\n\n### Recent errors\nNo such tool available',
    )
  })

  test('collects string tool_result errors', () => {
    const result = summarizeTranscript([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'boom', is_error: true }],
        },
      }),
    ])
    expect(result).toContain('### Recent errors\nboom')
  })

  test('ignores tool_result blocks without is_error', () => {
    const result = summarizeTranscript([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: [{ type: 'text', text: 'all good' }],
            },
          ],
        },
      }),
    ])
    expect(result).not.toContain('### Recent errors')
  })

  test('appends at most the three most recent errors', () => {
    const lines = ['e1', 'e2', 'e3', 'e4', 'e5'].map(errorResult)
    const result = summarizeTranscript(lines)
    expect(result).toContain('### Recent errors')
    expect(result).not.toContain('e1')
    expect(result).not.toContain('e2')
    expect(result.split('\n').slice(-3)).toEqual(['e3', 'e4', 'e5'])
  })

  test('truncates each error snippet to 200 characters', () => {
    const result = summarizeTranscript([errorResult('y'.repeat(400))])
    expect(result.endsWith('y'.repeat(200))).toBe(true)
    expect(result).not.toContain('y'.repeat(201))
  })
})
