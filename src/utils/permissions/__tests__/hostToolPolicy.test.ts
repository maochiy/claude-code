import { describe, expect, test } from 'bun:test'
import { evaluateHostToolPolicy } from '../hostToolPolicy.js'

describe('desktop host tool policy', () => {
  test('missing policy leaves standalone CLI permissions unchanged', () => {
    expect(evaluateHostToolPolicy('Bash', undefined).allowed).toBe(true)
  })
  test('empty allow list denies readonly and effectful tools alike', () => {
    for (const tool of ['Read', 'Bash', 'Agent', 'mcp__a__read']) {
      expect(evaluateHostToolPolicy(tool, '{"allowedTools":[]}')).toEqual({
        allowed: false,
        reason: 'not_allowed',
      })
    }
  })
  test('deny takes priority over wildcard allow and exact builtin aliases normalize', () => {
    const policy = JSON.stringify({
      allowedTools: ['read', 'mcp__files__*'],
      disallowedTools: ['mcp__files__delete'],
    })
    expect(evaluateHostToolPolicy('Read', policy).allowed).toBe(true)
    expect(evaluateHostToolPolicy('mcp__files__list', policy).allowed).toBe(
      true,
    )
    expect(evaluateHostToolPolicy('mcp__files__delete', policy).allowed).toBe(
      false,
    )
    expect(evaluateHostToolPolicy('Bash', policy).allowed).toBe(false)
    expect(evaluateHostToolPolicy('mcp__other__list', policy).allowed).toBe(
      false,
    )
  })
  test('malformed policies fail closed without exposing their contents', () => {
    for (const policy of [
      '',
      '{',
      'null',
      '[]',
      '{"unknown":true}',
      '{"allowedTools":null}',
      '{"allowedTools":["Bash(rm)"]}',
      '{"disallowedTools":[""]}',
      '{"allowedTools":[42]}',
    ]) {
      expect(evaluateHostToolPolicy('Read', policy)).toEqual({
        allowed: false,
        reason: 'invalid_policy',
      })
    }
  })
})
