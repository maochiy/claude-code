/**
 * Native host socket 路径约定。
 *
 * 每个 native host 进程（由 Chrome 按 profile 拉起）监听自己的 `<pid>.sock`，
 * 会话侧 client 扫描目录后逐个尝试连接——与官方 chromeNativeHost.ts 的
 * per-pid socket 方案一致，避免多 host 抢占同一 socket。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const BROWSER_PIPE_NAME = 'ccb-browser-use'

export function getBrowserSocketDir(): string {
  return join(homedir(), '.claude', 'browser-use')
}

export function getHostSocketPath(pid = process.pid): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${BROWSER_PIPE_NAME}`
  }
  return join(getBrowserSocketDir(), `${pid}.sock`)
}
