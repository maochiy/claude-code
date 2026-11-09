import { describe, expect, test } from 'bun:test'
import App, { handleMouseEvent } from './App.js'
import { createSelectionState } from '../core/selection.js'
import type { ParsedMouse } from '../core/parse-keypress.js'

function harness(consume = true) {
  const actions: Array<[number, number, string]> = []
  const selection = createSelectionState()
  const app = Object.assign(Object.create(App.prototype), {
    props: {
      selection,
      onMouseAction: (col: number, row: number, type: string) => {
        actions.push([col, row, type])
        return consume
      },
      onSelectionChange() {},
      onSelectionDrag() {},
      onHoverAt() {},
      onClickAt: () => true,
    },
    mouseRowOffset: 30,
    mouseCaptured: false,
    clickCount: 0,
  }) as App
  return { app, actions, selection }
}

const mouse = (
  button: number,
  action: 'press' | 'release',
  row = 4,
): ParsedMouse => ({ kind: 'mouse', sequence: '', button, action, col: 8, row })

describe('editable mouse capture', () => {
  test('calibrates tall main-screen frames from the reported physical caret', async () => {
    const { app, actions } = harness()
    Object.assign(app.props, { getMouseCursorRow: () => 100 })
    app.querier = {
      send: () => Promise.resolve({ type: 'cursorPosition', row: 20, col: 1 }),
      flush: () => Promise.resolve(),
    } as unknown as App['querier']
    app.handleMouse(mouse(0, 'press', 19))
    await Promise.resolve()
    // Logical y=100 at physical y=19 means viewport top is logical y=81.
    expect(actions[0]).toEqual([7, 99, 'mousedown'])
  })

  test('does not edit at guessed coordinates when DSR is unsupported', async () => {
    const { app, actions } = harness()
    Object.assign(app.props, { getMouseCursorRow: () => 100 })
    app.querier = {
      send: () => Promise.resolve(undefined),
      flush: () => Promise.resolve(),
    } as unknown as App['querier']
    app.handleMouse(mouse(0, 'press'))
    await Promise.resolve()
    expect(actions).toEqual([])
  })
  test('maps main-screen rows and captures drag/release outside the input', () => {
    const { app, actions, selection } = harness()
    handleMouseEvent(app, mouse(0, 'press'))
    handleMouseEvent(app, mouse(32, 'press', 1))
    handleMouseEvent(app, mouse(0, 'release', 1))
    expect(actions).toEqual([
      [7, 33, 'mousedown'],
      [7, 30, 'mousedrag'],
      [7, 30, 'mouseup'],
    ])
    expect(app.mouseCaptured).toBe(false)
    expect(selection.anchor).toBeNull()
  })

  test('recovers a dropped release on no-button motion', () => {
    const { app, actions } = harness()
    handleMouseEvent(app, mouse(0, 'press'))
    handleMouseEvent(app, mouse(35, 'press'))
    expect(actions.at(-1)?.[2]).toBe('mouseup')
    expect(app.mouseCaptured).toBe(false)
  })

  test('keeps message-area selection when no editable handler consumes the press', () => {
    const { app, selection } = harness(false)
    handleMouseEvent(app, mouse(0, 'press'))
    expect(app.mouseCaptured).toBe(false)
    expect(selection.anchor).toEqual({ col: 7, row: 33 })
    expect(selection.isDragging).toBe(true)
  })
})
