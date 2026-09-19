import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isSynchronizedOutputSupported } from '../terminal.js'

const RELEVANT_ENV = [
  'TMUX',
  'TERM_PROGRAM',
  'TERM',
  'KITTY_WINDOW_ID',
  'ZED_TERM',
  'WT_SESSION',
  'VTE_VERSION',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const name of RELEVANT_ENV) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of RELEVANT_ENV) {
    const value = saved[name]
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

describe('isSynchronizedOutputSupported', () => {
  test('Otty reports support despite TERM=xterm-256color', () => {
    process.env.TERM_PROGRAM = 'otty'
    process.env.TERM = 'xterm-256color'
    expect(isSynchronizedOutputSupported()).toBe(true)
  })

  test('bare xterm-256color without a known TERM_PROGRAM is unsupported', () => {
    process.env.TERM = 'xterm-256color'
    expect(isSynchronizedOutputSupported()).toBe(false)
  })

  test('tmux disables support even under a supporting TERM_PROGRAM', () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0'
    process.env.TERM_PROGRAM = 'otty'
    expect(isSynchronizedOutputSupported()).toBe(false)
  })
})
