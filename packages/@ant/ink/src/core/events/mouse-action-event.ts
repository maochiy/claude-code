import { Event } from './event.js'
import type { EventTarget } from './terminal-event.js'
import type { DOMElement } from '../dom.js'
import { nodeCache } from '../node-cache.js'

/**
 * Mouse action event (mousedown, mouseup, mousedrag).
 * Bubbles from the deepest hit node up through parentNode.
 */
export class MouseActionEvent extends Event {
  /** Action type */
  readonly type: 'mousedown' | 'mouseup' | 'mousedrag'
  /** 0-indexed screen column */
  readonly col: number
  /** 0-indexed screen row */
  readonly row: number
  /** Mouse button number */
  readonly button: number
  /**
   * Column relative to the current handler's Box.
   * Recomputed before each handler fires.
   */
  localCol = 0
  /** Row relative to the current handler's Box. */
  localRow = 0

  constructor(
    type: 'mousedown' | 'mouseup' | 'mousedrag',
    col: number,
    row: number,
    button: number,
  ) {
    super()
    this.type = type
    this.col = col
    this.row = row
    this.button = button
  }

  /** Recompute local coords relative to the target Box. */
  prepareForTarget(target: EventTarget): void {
    // Cached rects include all ancestors and ScrollBox translations.
    const rect = nodeCache.get(target as unknown as DOMElement)
    this.localCol = this.col - (rect?.x ?? 0)
    this.localRow = this.row - (rect?.y ?? 0)
  }
}
