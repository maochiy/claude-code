import { readdir, stat } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import {
  BrowserError,
  FrameDecoder,
  encodeFrame,
  requestEnvelope,
  type ProtocolMessage,
  type RequestExtra,
} from './protocol.js'
import { getBrowserSocketDir, getHostSocketPath } from './paths.js'

export type ClientRequestOptions = {
  timeoutMs?: number
  connectTimeoutMs?: number
  socketPaths?: () => string[] | Promise<string[]>
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: BrowserError) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const CONNECT_RETRY_INTERVAL_MS = 250

/** 扫描 socket 目录里所有存活 host 的 socket 路径（win32 返回命名管道）。 */
export async function discoverHostSocketPaths(): Promise<string[]> {
  if (process.platform === 'win32') {
    return [getHostSocketPath()]
  }
  const dir = getBrowserSocketDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const paths: { path: string; mtime: number }[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.sock')) continue
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      paths.push({ path, mtime: info.mtimeMs })
    } catch {
      // socket 文件刚好被清掉，跳过
    }
  }
  return paths.sort((a, b) => b.mtime - a.mtime).map(entry => entry.path)
}

/**
 * 会话侧 socket client：连接 native host 的 socket，
 * 请求/响应按 id 匹配，超时 30s，host 不在线时报可重试的 EXTENSION_OFFLINE。
 */
export class BrowserSocketClient {
  private socket: net.Socket | null = null
  private decoder = new FrameDecoder()
  private pending = new Map<string, PendingRequest>()
  private nextId = 1
  private connecting: Promise<net.Socket> | null = null
  private readonly timeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly socketPaths: () => string[] | Promise<string[]>

  constructor(options: ClientRequestOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.socketPaths = options.socketPaths ?? discoverHostSocketPaths
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    extra: RequestExtra = {},
  ): Promise<unknown> {
    const socket = await this.ensureConnected()
    const id = `ccb-${process.pid}-${this.nextId++}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new BrowserError(
            'REQUEST_TIMEOUT',
            `Extension request timed out: ${method}`,
            { retryable: true, details: { method } },
          ),
        )
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.write(encodeFrame(requestEnvelope(id, method, params, extra)))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new BrowserError(
            'EXTENSION_OFFLINE',
            `Native host write failed: ${(error as Error).message}`,
            { retryable: true },
          ),
        )
      }
    })
  }

  /** 关闭连接并拒绝所有在途请求（测试收尾用）。 */
  close(): void {
    this.rejectPending(
      new BrowserError('BRIDGE_STOPPED', 'Browser client closed', {
        retryable: true,
      }),
    )
    this.socket?.destroy()
    this.socket = null
  }

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<net.Socket> {
    const deadline = Date.now() + this.connectTimeoutMs
    let lastPaths: string[] = []
    while (Date.now() < deadline) {
      lastPaths = await this.socketPaths()
      for (const path of lastPaths) {
        const socket = await this.tryConnect(path)
        if (socket) return socket
      }
      await sleep(CONNECT_RETRY_INTERVAL_MS)
    }
    throw new BrowserError(
      'EXTENSION_OFFLINE',
      'Chrome extension is not connected: native host socket not reachable（请确认 Chrome 已启动且扩展已启用）',
      { retryable: true, details: { sockets: lastPaths } },
    )
  }

  private tryConnect(path: string): Promise<net.Socket | null> {
    return new Promise(resolve => {
      const socket = net.createConnection(path)
      let settled = false
      socket.once('connect', () => {
        settled = true
        this.attach(socket)
        resolve(socket)
      })
      socket.once('error', () => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(null)
      })
    })
  }

  private attach(socket: net.Socket): void {
    this.socket = socket
    socket.on('data', chunk => {
      try {
        for (const message of this.decoder.push(chunk)) {
          this.receive(message)
        }
      } catch {
        socket.destroy()
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      this.rejectPending(
        new BrowserError('EXTENSION_OFFLINE', 'Native host disconnected', {
          retryable: true,
        }),
      )
    })
    socket.on('error', () => {})
  }

  private receive(message: ProtocolMessage): void {
    if (message.type !== 'response') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok === false) {
      pending.reject(
        new BrowserError(
          message.error?.code || 'BACKEND_ERROR',
          message.error?.message || 'Extension request failed',
          {
            retryable: message.error?.retryable ?? false,
            details: message.error?.details ?? {},
          },
        ),
      )
      return
    }
    pending.resolve(message.result)
  }

  private rejectPending(error: BrowserError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

let singleton: BrowserSocketClient | null = null

/** 全部 Browser* 工具共享的 client 单例。 */
export function getBrowserClient(): BrowserSocketClient {
  if (!singleton) singleton = new BrowserSocketClient()
  return singleton
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
