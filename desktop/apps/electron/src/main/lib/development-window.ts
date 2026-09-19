import type { BrowserWindow } from 'electron'
import { isViteDevOrigin } from './vite-dev-origin'

/** Vite 更新依赖会短暂重启；恢复当前开发页，避免窗口永久停在连接失败页。 */
export function loadDevelopmentWindow(window: BrowserWindow, url: string): void {
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  const load = (): void => {
    if (window.isDestroyed()) return
    void window.loadURL(url).catch(() => { /* did-fail-load 统一安排重试。 */ })
  }
  window.webContents.on('did-fail-load', (_event, errorCode, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !isViteDevOrigin(failedUrl) || window.isDestroyed()) return
    clearTimeout(retry)
    if (attempts++ >= 30) return
    retry = setTimeout(load, 1000)
  })
  window.webContents.on('did-finish-load', () => {
    if (isViteDevOrigin(window.webContents.getURL())) { attempts = 0; clearTimeout(retry) }
  })
  window.once('closed', () => clearTimeout(retry))
  load()
}
