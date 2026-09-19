import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BuiltinMcpServerDefinition, BuiltinMcpToolDefinition } from './tool-definition'
import { isBuiltinMcpServerDefinition } from './tool-definition'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const ENDPOINT_CLOSE_TIMEOUT_MS = 750
const HTTP_CLOSE_TIMEOUT_MS = 1_000

interface HostedEndpoint {
  sessionId: string
  serverName: string
  path: string
  token: string
  definition: BuiltinMcpServerDefinition
  tools: Map<string, BuiltinMcpToolDefinition>
  server: McpServer
  transport: StreamableHTTPServerTransport
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new Error('MCP 请求体超过 2 MB 限制')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('MCP 请求体超过 2 MB 限制')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
}

class PromaBuiltinMcpHttpHost {
  private httpServer: Server | undefined
  private pendingServer: Server | undefined
  private port: number | undefined
  private startPromise: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private shuttingDown = false
  private readonly sockets = new Set<Socket>()
  private readonly endpoints = new Map<string, HostedEndpoint>()
  private readonly endpointKeys = new Map<string, string>()

  async materialize(
    sessionId: string,
    configs: Record<string, Record<string, unknown>>,
  ): Promise<Record<string, Record<string, unknown>>> {
    if (this.shuttingDown) throw new Error('内置 MCP HTTP Host 正在退出')
    const entries = Object.entries(configs)
    if (!entries.some(([, config]) => isBuiltinMcpServerDefinition(config))) {
      return Object.fromEntries(entries)
    }

    await this.ensureStarted()
    if (this.shuttingDown) throw new Error('内置 MCP HTTP Host 正在退出')
    const result: Record<string, Record<string, unknown>> = {}

    for (const [name, config] of entries) {
      if (!isBuiltinMcpServerDefinition(config)) {
        result[name] = config
        continue
      }
      const endpoint = await this.upsertEndpoint(sessionId, name, config)
      result[name] = {
        type: 'http',
        url: `http://127.0.0.1:${this.port}${endpoint.path}`,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
        required: false,
      }
    }

    return result
  }

  async releaseSession(sessionId: string): Promise<void> {
    const endpoints = Array.from(this.endpoints.values())
      .filter((endpoint) => endpoint.sessionId === sessionId)
    for (const endpoint of endpoints) {
      this.endpoints.delete(endpoint.path)
      this.endpointKeys.delete(this.endpointKey(endpoint.sessionId, endpoint.serverName))
      const closing = Promise.allSettled([
        Promise.resolve().then(() => endpoint.transport.close()),
        Promise.resolve().then(() => endpoint.server.close()),
      ])
      await this.settleWithin(closing, ENDPOINT_CLOSE_TIMEOUT_MS)
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.shutdownPromise = this.performShutdown().finally(() => {
      this.shuttingDown = false
      this.shutdownPromise = undefined
    })
    return this.shutdownPromise
  }

  private endpointKey(sessionId: string, serverName: string): string {
    return `${sessionId}\0${serverName}`
  }

  private async ensureStarted(): Promise<void> {
    if (this.shuttingDown) throw new Error('内置 MCP HTTP Host 正在退出')
    if (this.httpServer && this.port) return
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      this.pendingServer = server
      const failStart = (error: Error): void => {
        if (this.pendingServer === server) this.pendingServer = undefined
        reject(error)
      }
      const closedBeforeReady = (): void => failStart(new Error('内置 MCP HTTP Host 在启动完成前关闭'))
      server.once('error', failStart)
      server.once('close', closedBeforeReady)
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      server.listen(0, '127.0.0.1', () => {
        if (this.shuttingDown) {
          server.close()
          failStart(new Error('内置 MCP HTTP Host 正在退出'))
          return
        }
        const address = server.address()
        if (!address || typeof address === 'string') {
          failStart(new Error('无法获取内置 MCP HTTP Host 监听地址'))
          return
        }
        server.removeListener('error', failStart)
        server.removeListener('close', closedBeforeReady)
        this.pendingServer = undefined
        server.on('error', (error) => {
          console.error('[内置 MCP] HTTP Host 错误:', error)
        })
        this.httpServer = server
        this.port = address.port
        console.log(`[内置 MCP] HTTP Host 已启动: 127.0.0.1:${address.port}`)
        resolve()
      })
    })

    try {
      await this.startPromise
    } catch (error) {
      this.startPromise = undefined
      throw error
    }
  }

  private async performShutdown(): Promise<void> {
    const endpoints = Array.from(this.endpoints.values())
    this.endpoints.clear()
    this.endpointKeys.clear()
    await Promise.all(endpoints.map(async (endpoint) => {
      const closing = Promise.allSettled([
        Promise.resolve().then(() => endpoint.transport.close()),
        Promise.resolve().then(() => endpoint.server.close()),
      ])
      await this.settleWithin(closing, ENDPOINT_CLOSE_TIMEOUT_MS)
    }))

    const server = this.httpServer ?? this.pendingServer
    this.httpServer = undefined
    this.pendingServer = undefined
    this.port = undefined
    this.startPromise = undefined
    if (!server) return

    const closed = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
      server.closeIdleConnections?.()
      for (const socket of this.sockets) socket.destroy()
      server.closeAllConnections?.()
    })
    const didClose = await this.settleWithin(closed, HTTP_CLOSE_TIMEOUT_MS)
    if (!didClose) {
      for (const socket of this.sockets) socket.destroy()
      server.closeAllConnections?.()
      console.warn('[内置 MCP] HTTP Host 未在退出期限内确认关闭')
    }
    this.sockets.clear()
  }

  private async settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async upsertEndpoint(
    sessionId: string,
    serverName: string,
    definition: BuiltinMcpServerDefinition,
  ): Promise<HostedEndpoint> {
    const key = this.endpointKey(sessionId, serverName)
    const existingPath = this.endpointKeys.get(key)
    const existing = existingPath ? this.endpoints.get(existingPath) : undefined
    if (existing) {
      existing.definition = definition
      existing.tools.clear()
      for (const tool of definition.tools) existing.tools.set(tool.name, tool)
      return existing
    }

    const path = `/mcp/${randomUUID()}`
    const tools = new Map(definition.tools.map((tool) => [tool.name, tool]))
    const mcpServer = new McpServer({
      name: definition.name,
      version: definition.version,
    })
    for (const tool of definition.tools) {
      mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        async (args) => {
          const current = tools.get(tool.name)
          if (!current) {
            return {
              isError: true,
              content: [{ type: 'text', text: `工具已不可用: ${tool.name}` }],
            }
          }
          return current.execute(args)
        },
      )
    }
    const transport = new StreamableHTTPServerTransport({
      // 每个 Proma Session/Server endpoint 只由一个 CCB MCP Client 使用。
      // 必须启用 SDK Session：stateless transport 按协议不能跨多个 HTTP 请求复用。
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    })
    await mcpServer.connect(transport)
    const endpoint: HostedEndpoint = {
      sessionId,
      serverName,
      path,
      token: randomBytes(32).toString('hex'),
      definition,
      tools,
      server: mcpServer,
      transport,
    }
    this.endpoints.set(path, endpoint)
    this.endpointKeys.set(key, path)
    return endpoint
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const endpoint = this.endpoints.get(url.pathname)
      if (!endpoint) {
        res.writeHead(404).end('Not Found')
        return
      }
      const authorization = req.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!token || !secureTokenEquals(token, endpoint.token)) {
        res.writeHead(401).end('Unauthorized')
        return
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      await endpoint.transport.handleRequest(req, res, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) {
        res.writeHead(message.includes('2 MB') ? 413 : 400, { 'content-type': 'application/json' })
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: message }))
      }
    }
  }
}

export const promaBuiltinMcpHttpHost = new PromaBuiltinMcpHttpHost()
