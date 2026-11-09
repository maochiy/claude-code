import { describe, expect, test } from 'bun:test'
import { LogUpdate } from '../log-update.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  diff,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../screen.js'

function cachedScreen() {
  const styles = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  const prev = createScreen(6, 1, styles, chars, links)
  const next = createScreen(6, 1, styles, chars, links)
  const write = (
    screen: typeof prev,
    x: number,
    char: string,
    width: CellWidth,
  ) =>
    setCellAt(screen, x, 0, {
      char,
      width,
      styleId: styles.none,
      hyperlink: undefined,
    })
  return { prev, next, write, styles }
}

describe('setCellAt damage', () => {
  test('emits a space to erase stale terminal content beyond an overlapping wide cell', () => {
    const { prev, next, write, styles } = cachedScreen()
    write(prev, 3, 'X', CellWidth.Narrow)
    prev.damage = undefined
    // A cached child is painted before an overlapping sibling replaces it.
    write(next, 2, '界', CellWidth.Wide)
    next.damage = undefined
    write(next, 1, '本', CellWidth.Wide)

    const frame = (screen: typeof prev) => ({
      screen,
      viewport: { width: 6, height: 10 },
      cursor: { x: 0, y: 1, visible: false },
    })
    const patches = new LogUpdate({ isTTY: true, stylePool: styles }).render(
      frame(prev),
      frame(next),
    )
    expect(
      patches
        .filter(patch => patch.type === 'stdout')
        .map(patch => patch.content),
    ).toContain(' ')
    expect(patches.some(patch => patch.type === 'clearTerminal')).toBe(false)
  })

  test('includes the cleared tail when replacing a cached wide cell with a narrow cell', () => {
    const { prev, next, write } = cachedScreen()
    write(prev, 1, '界', CellWidth.Wide)
    next.cells.set(prev.cells)
    prev.damage = undefined
    write(next, 1, 'a', CellWidth.Narrow)

    expect(diff(prev, next).map(([point]) => point.x)).toEqual([1, 2])
    expect(diff(prev, next)[1]?.[2]?.char).toBe(' ')
  })

  test('expands existing damage to include a cleared tail on its right edge', () => {
    const { prev, next, write } = cachedScreen()
    write(prev, 1, '界', CellWidth.Wide)
    next.cells.set(prev.cells)
    prev.damage = undefined
    write(next, 0, 'z', CellWidth.Narrow)
    write(next, 1, 'a', CellWidth.Narrow)

    expect(diff(prev, next).map(([point]) => point.x)).toEqual([0, 1, 2])
  })

  test('includes the orphan tail cleared by an overlapping wide cell', () => {
    const { prev, next, write } = cachedScreen()
    write(prev, 2, '界', CellWidth.Wide)
    next.cells.set(prev.cells)
    prev.damage = undefined
    write(next, 1, '本', CellWidth.Wide)

    expect(diff(prev, next).map(([point]) => point.x)).toEqual([1, 2, 3])
    expect(diff(prev, next)[2]?.[2]?.char).toBe(' ')
  })
})
