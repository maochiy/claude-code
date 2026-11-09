import { describe, expect, test } from 'bun:test'
import type { DOMElement } from '../dom.js'
import { nodeCache } from '../node-cache.js'
import { MouseActionEvent } from './mouse-action-event.js'

describe('MouseActionEvent', () => {
  test('uses rendered absolute coordinates including ancestor and scroll offsets', () => {
    const node = {} as DOMElement
    nodeCache.set(node, { x: 3, y: 42, width: 20, height: 4 } as Parameters<
      typeof nodeCache.set
    >[1])
    const event = new MouseActionEvent('mousedrag', 9, 44, 0)
    event.prepareForTarget(node)
    expect(event.localCol).toBe(6)
    expect(event.localRow).toBe(2)
    nodeCache.delete(node)
  })

  test('preserves out-of-bounds coordinates for captured drags', () => {
    const node = {} as DOMElement
    nodeCache.set(node, { x: 3, y: 42, width: 20, height: 4 } as Parameters<
      typeof nodeCache.set
    >[1])
    const event = new MouseActionEvent('mouseup', 1, 40, 0)
    event.prepareForTarget(node)
    expect(event.localCol).toBe(-2)
    expect(event.localRow).toBe(-2)
    nodeCache.delete(node)
  })
})
