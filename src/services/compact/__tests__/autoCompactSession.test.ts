import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSessionAutoCompactOverride,
  resolveSessionAutoCompactEnabled,
  setSessionAutoCompactOverride,
} from '../autoCompactSession.js'

afterEach(() => {
  setSessionAutoCompactOverride(undefined)
})

describe('session auto-compact override', () => {
  test('falls back to configured behavior when override is cleared', () => {
    expect(resolveSessionAutoCompactEnabled(true, false)).toBe(true)
    expect(resolveSessionAutoCompactEnabled(false, false)).toBe(false)
  })

  test('overrides configured behavior for the current session', () => {
    setSessionAutoCompactOverride(false)
    expect(getSessionAutoCompactOverride()).toBe(false)
    expect(resolveSessionAutoCompactEnabled(true, false)).toBe(false)

    setSessionAutoCompactOverride(true)
    expect(resolveSessionAutoCompactEnabled(false, false)).toBe(true)
  })

  test('does not override an environment hard-disable', () => {
    setSessionAutoCompactOverride(true)
    expect(resolveSessionAutoCompactEnabled(true, true)).toBe(false)
  })
})
