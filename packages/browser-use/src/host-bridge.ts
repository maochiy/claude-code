// biome-ignore-all lint/suspicious/noConsole: native host 进程独立于 CLI，诊断走 stderr
/**
 * Native host 桥：Chrome 通过 native messaging 拉起本进程（stdio），
 * 进程在 `~/.claude/browser-use/<pid>.sock` 上监听；所有 ccx 会话作为
 * client 连入。会话请求按「连接前缀 + 原始 id」改写后转发给扩展，
 * 扩展响应再按路由表送回来源连接——支持多会话并发。
 */
import { chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { platform } from 'node:os'
import {
  BrowserError,
  FrameDecoder,
  encodeFrame,
  errorEnvelope,
  PROTOCOL,
  responseEnvelope,
  type ProtocolMessage,
} from './protocol.js'
import { getBrowserSocketDir, getHostSocketPath } from './paths.js'

type HostBridgeOptions = {
  socketPath?: string
  /** 覆盖向扩展（stdout）写出帧的通道，测试注入用。 */
  writeToExtension?: (frame: Buffer) => void
}

class BrowserHostBridge {
  private readonly socketPath: string
  private readonly writeToExtension: (frame: Buffer) => void
  private server: Server | null = null
  private clients = new Map<number, Socket>()
  private clientDecoders = new Map<number, FrameDecoder>()
  private routing = new Map<string, number>()
  private extensionDecoder = new FrameDecoder()
  private nextConnectionId = 1
  private running = false

  constructor(options: HostBridgeOptions = {}) {
    this.socketPath = options.socketPath ?? getHostSocketPath()
    this.writeToExtension =
      options.writeToExtension ??
      ((frame: Buffer) => {
        process.stdout.write(frame)
      })
  }

  get listening(): boolean {
    return this.running
  }

  get clientCount(): number {
    return this.clients.size
  }

  async start(): Promise<void> {
    if (this.running) return
    if (platform() !== 'win32') {
      const dir = getBrowserSocketDir()
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700).catch(() => {})
      await this.cleanStaleSockets(dir)
    }
    this.server = createServer(socket => this.acceptClient(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        this.running = true
        resolve()
      }
      this.server!.once('error', onError)
      this.server!.once('listening', onListening)
      this.server!.listen(this.socketPath)
    })
    if (platform() !== 'win32') {
      await chmod(this.socketPath, 0o600).catch(() => {})
    }
    this.log(`listening on ${this.socketPath}`)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const [, socket] of this.clients) socket.destroy()
    this.clients.clear()
    this.clientDecoders.clear()
    this.routing.clear()
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    if (platform() !== 'win32') {
      await unlink(this.socketPath).catch(() => {})
    }
    this.log('stopped')
  }

  /** 扩展（stdin）原始字节入口。 */
  handleExtensionData(chunk: Buffer): void {
    try {
      for (const message of this.extensionDecoder.push(chunk)) {
        this.handleExtensionMessage(message)
      }
    } catch (error) {
      this.log(`bad extension frame: ${(error as Error).message}`)
    }
  }

  handleExtensionMessage(message: ProtocolMessage): void {
    if (message.type === 'request') {
      // 扩展侧主动请求只支持 ping（连接探活）；其余不路由。
      if (message.method === 'ping') {
        this.sendToExtension(
          responseEnvelope(message.id, { protocol: PROTOCOL }),
        )
      } else {
        this.sendToExtension(
          errorEnvelope(
            message.id,
            new BrowserError(
              'BAD_METHOD',
              `Extension-originated method is not routed: ${message.method}`,
            ),
          ),
        )
      }
      return
    }
    if (message.type === 'response') {
      const connectionId = this.routing.get(message.id)
      if (connectionId == null) return
      this.routing.delete(message.id)
      const socket = this.clients.get(connectionId)
      if (!socket || socket.destroyed) return
      const originalId = message.id.slice(`${connectionId}:`.length)
      this.writeToClient(socket, { ...message, id: originalId })
    }
  }

  private acceptClient(socket: Socket): void {
    const connectionId = this.nextConnectionId++
    const decoder = new FrameDecoder()
    this.clients.set(connectionId, socket)
    this.clientDecoders.set(connectionId, decoder)
    this.log(`client ${connectionId} connected (total ${this.clients.size})`)

    socket.on('data', chunk => {
      try {
        for (const message of decoder.push(chunk)) {
          this.handleClientMessage(connectionId, message)
        }
      } catch (error) {
        this.log(`bad client frame: ${(error as Error).message}`)
        socket.destroy()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.clients.delete(connectionId)
      this.clientDecoders.delete(connectionId)
      for (const [id, owner] of this.routing) {
        if (owner === connectionId) this.routing.delete(id)
      }
      this.log(
        `client ${connectionId} disconnected (total ${this.clients.size})`,
      )
    })
  }

  private handleClientMessage(
    connectionId: number,
    message: ProtocolMessage,
  ): void {
    if (message.type !== 'request') return
    const forwardedId = `${connectionId}:${message.id}`
    if (this.routing.has(forwardedId)) return
    this.routing.set(forwardedId, connectionId)
    this.sendToExtension({ ...message, id: forwardedId })
  }

  private sendToExtension(message: ProtocolMessage): void {
    try {
      this.writeToExtension(encodeFrame(message))
    } catch (error) {
      this.log(`write to extension failed: ${(error as Error).message}`)
    }
  }

  private writeToClient(socket: Socket, message: ProtocolMessage): void {
    try {
      socket.write(encodeFrame(message))
    } catch {
      socket.destroy()
    }
  }

  private async cleanStaleSockets(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.sock')) continue
      const path = `${dir}/${entry}`
      if (path === this.socketPath) continue
      const pid = Number.parseInt(entry.slice(0, -5), 10)
      if (Number.isNaN(pid)) continue
      try {
        const info = await stat(path)
        if (!info.isSocket() && !info.isFile()) continue
      } catch {
        continue
      }
      try {
        process.kill(pid, 0)
      } catch {
        await unlink(path).catch(() => {})
        this.log(`removed stale socket for pid ${pid}`)
      }
    }
  }

  private log(message: string): void {
    console.error(`[ccb-browser-host] ${message}`)
  }
}

export async function runBrowserNativeHost(): Promise<void> {
  const bridge = new BrowserHostBridge()
  await bridge.start()
  process.stdin.on('data', chunk => {
    bridge.handleExtensionData(chunk as Buffer)
  })
  const finished = new Promise<void>(resolve => {
    const onEnd = () => resolve()
    process.stdin.once('end', onEnd)
    process.stdin.once('close', onEnd)
  })
  await finished
  await bridge.stop()
}

export { BrowserHostBridge }
