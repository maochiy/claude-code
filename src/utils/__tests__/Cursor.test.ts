import { describe, expect, test } from 'bun:test'
import { Cursor } from '../Cursor.js'

const invert = (text: string): string => `[${text}]`

function render(cursor: Cursor): string {
  return cursor.render(' ', '', invert)
}

describe('Cursor terminal soft-wrap whitespace', () => {
  test('keeps exact-width CJK input on one visible line', () => {
    const cursor = Cursor.fromText('中文中文', 9, 4)

    expect(cursor.measuredText.lineCount).toBe(1)
    expect(cursor.getPosition()).toEqual({ line: 0, column: 8 })
    expect(
      cursor.measuredText.getOffsetFromPosition(cursor.getPosition()),
    ).toBe(cursor.offset)
    expect(cursor.endOfLine().offset).toBe(cursor.offset)
    expect(render(cursor)).not.toContain('\n')
  })

  test('folds trailing ASCII whitespace-only continuations onto the previous line', () => {
    const cursor = Cursor.fromText('中文中文  ', 9, 6)

    expect(cursor.text).toBe('中文中文  ')
    expect(cursor.offset).toBe(6)
    expect(cursor.measuredText.lineCount).toBe(1)
    expect(cursor.getPosition()).toEqual({ line: 0, column: 8 })
    expect(
      cursor.measuredText.getOffsetFromPosition(cursor.getPosition()),
    ).toBe(cursor.offset)
    expect(cursor.endOfLine().offset).toBe(cursor.offset)
    expect(render(cursor)).not.toContain('\n')
    expect(cursor.getViewportCharOffset(1)).toBe(0)
    expect(cursor.getViewportCharEnd(1)).toBe(cursor.text.length)
  })

  test('folds a trailing full-width space continuation onto the previous line', () => {
    const cursor = Cursor.fromText('中文中文　', 9, 5)

    expect(cursor.text).toBe('中文中文　')
    expect(cursor.offset).toBe(5)
    expect(cursor.measuredText.lineCount).toBe(1)
    expect(cursor.getPosition()).toEqual({ line: 0, column: 8 })
    expect(
      cursor.measuredText.getOffsetFromPosition(cursor.getPosition()),
    ).toBe(cursor.offset)
    expect(cursor.endOfLine().offset).toBe(cursor.offset)
    expect(render(cursor)).not.toContain('\n')
  })

  test('maps the folded endpoint of whitespace-only input to the raw text end', () => {
    const cursor = Cursor.fromText('      ', 5, 6)

    expect(cursor.measuredText.lineCount).toBe(1)
    expect(cursor.getPosition()).toEqual({ line: 0, column: 4 })
    expect(
      cursor.measuredText.getOffsetFromPosition(cursor.getPosition()),
    ).toBe(cursor.offset)
    expect(cursor.endOfLine().offset).toBe(cursor.offset)
  })

  test('preserves a second line created by a real newline', () => {
    const cursor = Cursor.fromText('中文中文\n', 9, 5)

    expect(cursor.measuredText.lineCount).toBe(2)
    expect(cursor.getPosition()).toEqual({ line: 1, column: 0 })
    expect(render(cursor)).toContain('\n')
  })

  test('preserves soft-wrapped continuation lines with visible content', () => {
    const cursor = Cursor.fromText('中文中文 a', 9, 6)

    expect(cursor.measuredText.lineCount).toBe(2)
    expect(cursor.getPosition()).toEqual({ line: 1, column: 1 })
    expect(render(cursor)).toContain('\n')
  })
})
