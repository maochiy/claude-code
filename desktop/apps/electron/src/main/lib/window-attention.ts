/**
 * 主窗口注意力提示。
 *
 * 只闪烁任务栏/Dock，不显示、聚焦或还原窗口；偏好关闭或窗口已聚焦时无动作。
 */

export interface AttentionWindow {
  isDestroyed: () => boolean
  isFocused: () => boolean
  flashFrame: (flag: boolean) => void
  once: (event: 'focus' | 'closed', listener: () => void) => unknown
  removeListener: (event: 'focus' | 'closed', listener: () => void) => unknown
}

export interface DockAttentionPort {
  bounce: (type: 'informational') => number
  cancelBounce: (id: number) => void
}

export interface WindowAttentionOptions {
  enabled: boolean
  platform: NodeJS.Platform
  dock?: DockAttentionPort
}

const activeCancels = new WeakMap<AttentionWindow, () => void>()

export function requestWindowAttention(
  win: AttentionWindow | null,
  options: WindowAttentionOptions,
): boolean {
  if (!options.enabled || !win || win.isDestroyed() || win.isFocused()) return false
  if (activeCancels.has(win)) return true

  let cancelPlatformAttention: () => void
  if (options.platform === 'darwin' && options.dock) {
    const bounceId = options.dock.bounce('informational')
    cancelPlatformAttention = () => options.dock?.cancelBounce(bounceId)
  } else {
    win.flashFrame(true)
    cancelPlatformAttention = () => {
      if (!win.isDestroyed()) win.flashFrame(false)
    }
  }

  const cancel = (): void => {
    if (!activeCancels.has(win)) return
    activeCancels.delete(win)
    win.removeListener('focus', cancel)
    win.removeListener('closed', cancel)
    cancelPlatformAttention()
  }

  activeCancels.set(win, cancel)
  win.once('focus', cancel)
  win.once('closed', cancel)
  return true
}
