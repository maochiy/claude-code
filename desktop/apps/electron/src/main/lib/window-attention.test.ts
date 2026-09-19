import { describe, expect, test } from 'bun:test'
import {
  requestWindowAttention,
  type AttentionWindow,
  type DockAttentionPort,
} from './window-attention'

function createWindow(focused = false): {
  win: AttentionWindow
  flashes: boolean[]
  emit: (event: 'focus' | 'closed') => void
} {
  const listeners = new Map<string, () => void>()
  const flashes: boolean[] = []
  return {
    flashes,
    emit: (event) => listeners.get(event)?.(),
    win: {
      isDestroyed: () => false,
      isFocused: () => focused,
      flashFrame: (flag) => { flashes.push(flag) },
      once: (event, listener) => { listeners.set(event, listener) },
      removeListener: (event) => { listeners.delete(event) },
    },
  }
}

describe('窗口注意力提示', () => {
  test('Given 偏好关闭 When 收到阻塞通知 Then 不闪烁也不聚焦', () => {
    const harness = createWindow(false)
    const requested = requestWindowAttention(harness.win, {
      enabled: false,
      platform: 'win32',
    })

    expect(requested).toBe(false)
    expect(harness.flashes).toEqual([])
  })

  test('Given 主窗口已聚焦 When 收到阻塞通知 Then 不产生额外提示', () => {
    const harness = createWindow(true)
    expect(requestWindowAttention(harness.win, { enabled: true, platform: 'linux' })).toBe(false)
    expect(harness.flashes).toEqual([])
  })

  test('Given 窗口未聚焦且偏好开启 When 请求注意 Then 闪烁到窗口重新聚焦', () => {
    const harness = createWindow(false)
    expect(requestWindowAttention(harness.win, { enabled: true, platform: 'win32' })).toBe(true)
    expect(harness.flashes).toEqual([true])

    harness.emit('focus')
    expect(harness.flashes).toEqual([true, false])
  })

  test('Given macOS When 请求注意 Then 使用 informational Dock bounce 并可取消', () => {
    const harness = createWindow(false)
    const bounces: number[] = []
    const cancelled: number[] = []
    const dock: DockAttentionPort = {
      bounce: () => {
        bounces.push(7)
        return 7
      },
      cancelBounce: (id) => { cancelled.push(id) },
    }

    expect(requestWindowAttention(harness.win, { enabled: true, platform: 'darwin', dock })).toBe(true)
    harness.emit('focus')

    expect(bounces).toEqual([7])
    expect(cancelled).toEqual([7])
    expect(harness.flashes).toEqual([])
  })
})
