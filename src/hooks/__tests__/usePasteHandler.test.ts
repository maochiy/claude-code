import { describe, expect, test } from 'bun:test'
import { PASTE_THRESHOLD } from '../../utils/imagePaste.js'
import { shouldShowPasteFeedback } from '../usePasteHandler.js'

describe('shouldShowPasteFeedback', () => {
  test('hides feedback for short single-line bracketed input', () => {
    expect(shouldShowPasteFeedback('中文', false)).toBe(false)
    expect(shouldShowPasteFeedback('short clipboard text', false)).toBe(false)
  })

  test('shows feedback when buffered chunks exceed the large-paste threshold', () => {
    expect(shouldShowPasteFeedback('x'.repeat(500), false, 1000)).toBe(true)
  })

  test('shows feedback for multiline input', () => {
    expect(shouldShowPasteFeedback('first\nsecond', false)).toBe(true)
    expect(shouldShowPasteFeedback('first\rsecond', false)).toBe(true)
  })

  test('shows feedback for large input', () => {
    expect(
      shouldShowPasteFeedback('x'.repeat(PASTE_THRESHOLD + 1), false),
    ).toBe(true)
  })

  test('shows feedback for image paths', () => {
    expect(shouldShowPasteFeedback('/tmp/screenshot.png', true)).toBe(true)
  })
})
