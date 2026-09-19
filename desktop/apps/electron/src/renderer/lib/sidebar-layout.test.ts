import { describe, expect, test } from 'bun:test'
import { SIDEBAR_TITLEBAR_HEIGHT, SIDEBAR_TOGGLE_LEFT, SIDEBAR_TOGGLE_SIZE, sidebarChromeReserve, titlebarDragLeftOffset } from './sidebar-layout'
import { isPointerInSidebarPeekZone } from './sidebar-peek'

describe('侧栏标题栏交互', () => {
  test.each([true, false])('Given 侧栏折叠状态 %s When 在按钮中心点击 Then 按钮不被拖动区域覆盖', (sidebarCollapsed) => {
    const buttonCenter = SIDEBAR_TOGGLE_LEFT + SIDEBAR_TOGGLE_SIZE / 2
    const dragLeft = titlebarDragLeftOffset({ isMac: true, sidebarCollapsed, sidebarPeeking: false, leftSidebarWidth: 280 })
    expect(dragLeft).toBeGreaterThan(buttonCenter)
    expect(sidebarChromeReserve(true)).toBeGreaterThan(buttonCenter)
  })

  test('Given 鼠标仍位于折叠按钮 When 侧栏收起 Then 不会因悬停立即重新飞出', () => {
    const x = SIDEBAR_TOGGLE_LEFT + SIDEBAR_TOGGLE_SIZE / 2
    const y = SIDEBAR_TITLEBAR_HEIGHT / 2
    expect(isPointerInSidebarPeekZone(x, y, {
      panelWidth: 280, peeking: false, toggleChromeRight: sidebarChromeReserve(true),
    })).toBe(false)
    expect(titlebarDragLeftOffset({ isMac: true, sidebarCollapsed: true, sidebarPeeking: true, leftSidebarWidth: 280 })).toBe(280)
  })

  test('Given 侧栏从收起态重新展开 When 计算窗口拖动区 Then 清除飞出宽度且仍避开固定按钮', () => {
    const expandedDragLeft = titlebarDragLeftOffset({
      isMac: true,
      sidebarCollapsed: false,
      sidebarPeeking: false,
      leftSidebarWidth: 320,
    })

    expect(expandedDragLeft).toBe(sidebarChromeReserve(true))
    expect(expandedDragLeft).not.toBe(320)
  })
})
