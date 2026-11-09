import { describe, expect, test } from 'bun:test'
import { Cursor } from '../Cursor.js'

const invert = (text: string): string => `[${text}]`

function render(cursor: Cursor): string {
  return cursor.render(' ', '', invert)
}

describe('Cursor selections', () => {
  test('deletes forward and backward selections before individual characters', () => {
    for (const cursor of [
      Cursor.fromText('abcdef', 40, 5, -4),
      Cursor.fromText('abcdef', 40, 1, 4),
    ]) {
      expect(cursor.selectionRange).toEqual({ start: 1, end: 5 })
      for (const result of [
        cursor.del(),
        cursor.backspace(),
        cursor.deleteSelection(),
      ]) {
        expect(result.text).toBe('af')
        expect(result.offset).toBe(1)
        expect(result.selectionRange).toBeNull()
      }
    }
  })

  test('deletes or replaces whole image references when a selection crosses a chip', () => {
    const text = 'before [Image #1] after'
    expect(Cursor.fromText(text, 80, 12, -3).deleteSelection().text).toBe(
      'before  after',
    )
    expect(Cursor.fromText(text, 80, 12, -3).insert('new').text).toBe(
      'before new after',
    )
    expect(Cursor.fromText(text, 80, 14, -2).backspace().text).toBe(
      'before  after',
    )
  })

  test('deletes complete graphemes when selection ends inside a surrogate pair', () => {
    const text = 'a👩‍💻z'
    expect(Cursor.fromText(text, 40, 2, -1).deleteSelection().text).toBe('az')
    expect(Cursor.fromText(text, 40, 2, -1).insert('x').text).toBe('axz')
    expect(Cursor.fromText(text, 40, 1, 1).del().text).toBe('az')
  })

  test('replaces selections with typed or pasted multiline Unicode text', () => {
    const cursor = Cursor.fromText('a中文👩‍💻z', 40, 1, 7)
    const next = cursor.insert('你好\nworld')
    expect(next.text).toBe('a你好\nworldz')
    expect(next.offset).toBe('a你好\nworld'.length)
    expect(next.selectionRange).toBeNull()
  })

  test('replaces or deletes all text including a caret at either endpoint', () => {
    for (const cursor of [
      Cursor.fromText('abc', 40, 3, -3),
      Cursor.fromText('abc', 40, 0, 3),
    ]) {
      expect(cursor.backspace().text).toBe('')
      expect(cursor.del().text).toBe('')
      expect(cursor.insert('x').text).toBe('x')
    }
  })

  test('renders selected graphemes without splitting ANSI sequences', () => {
    const cursor = Cursor.fromText('a中👩‍💻z', 40, 7, -6)
    expect(
      cursor.render(
        ' ',
        '',
        invert,
        undefined,
        undefined,
        text => `\x1b[7m${text}\x1b[27m`,
      ),
    ).toBe('a\x1b[7m中\x1b[27m\x1b[7m👩‍💻\x1b[27m[z]')
  })

  test('renders selection across wraps and clips it to the viewport', () => {
    const cursor = Cursor.fromText('abcdefghij', 5, 10, -10)
    expect(cursor.render('', '', invert)).toBe(
      '[a][b][c][d]\n[e][f][g][h]\n[i][j]',
    )
    expect(cursor.render('', '', invert, undefined, 1)).toBe('[i][j]')
  })

  test('keeps selected trailing spaces visible and clamps stale anchors', () => {
    const cursor = Cursor.fromText('ab  ', 40, 0, 100)
    expect(cursor.selectionRange).toEqual({ start: 0, end: 4 })
    expect(cursor.render('', '', invert)).toBe('[a][b][ ][ ]')
    expect(cursor.del().text).toBe('')
  })
})

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
