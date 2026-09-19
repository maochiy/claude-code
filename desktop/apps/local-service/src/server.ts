import {
  DESKTOP_PROTOCOL_VERSION,
  type CliLaunchSpec,
  type DesktopEvent,
  type JsonValue,
  type LocalServiceReady,
  type SessionEventCursor,
  parseRpcRequest,
  rpcFailure,
} from '@proma/desktop-protocol'
import type { ServerWebSocket } from 'bun'
import servicePackage from '../package.json'
import { handleRpc } from './rpc-handler.ts'
import { SessionManager, compareDesktopEvents } from './session-manager.ts'

const SERVICE_VERSION = servicePackage.version
// 图片以 base64 content block 发送，预留单次多图消息空间。
const MAX_RPC_BODY_BYTES = 64 * 1024 * 1024
const MAX_CURSOR_QUERY_BYTES = 64 * 1024
const MAX_CURSOR_SESSIONS = 256
const MAX_REPLAY_BUFFER_EVENTS = 10_000
const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024

interface WebSocketData {
  sessionId?: string
  afterSeq: number
  cursors: Map<string, SessionEventCursor>
  lastCursorBySession: Map<string, SessionEventCursor>
  replaying: boolean
  buffered: DesktopEvent[]
}

function parseCursorQuery(raw: string | null): Map<string, SessionEventCursor> {
  const cursors = new Map<string, SessionEventCursor>()
  if (!raw) return cursors
  if (raw.length > MAX_CURSOR_QUERY_BYTES) {
    throw new Error('WebSocket cursor 参数过大')
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WebSocket cursor 参数格式无效')
  }
  const entries = Object.entries(parsed)
  if (entries.length > MAX_CURSOR_SESSIONS) {
    throw new Error('WebSocket cursor 会话数量超限')
  }
  for (const [sessionId, value] of entries) {
    if (
      !sessionId ||
      sessionId.length > 256 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new Error('WebSocket cursor 条目无效')
    }
    const cursor = value as Record<string, unknown>
    if (
      !Number.isInteger(cursor.generation) ||
      Number(cursor.generation) < 1 ||
      !Number.isInteger(cursor.seq) ||
      Number(cursor.seq) < 0
    ) {
      throw new Error('WebSocket cursor 数值无效')
    }
    cursors.set(sessionId, {
      generation: Number(cursor.generation),
      seq: Number(cursor.seq),
    })
  }
  return cursors
}

function isAfterCursor(event: DesktopEvent, cursor?: SessionEventCursor): boolean {
  if (!cursor) return true
  return (
    event.generation > cursor.generation ||
    (event.generation === cursor.generation && event.seq > cursor.seq)
  )
}

export interface LocalServiceOptions {
  token: string
  port?: number
  defaultCli?: CliLaunchSpec
  stateDir?: string
}

export interface LocalServiceHandle {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly ready: LocalServiceReady
  readonly manager: SessionManager
  shutdown(): Promise<void>
}

function isAuthorized(request: Request, token: string): boolean {
  const authorization = request.headers.get('authorization')
  return authorization === `Bearer ${token}`
}

function jsonResponse(value: JsonValue, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function startLocalService(
  options: LocalServiceOptions,
): LocalServiceHandle {
  if (!options.token) throw new Error('Local Service token is required')
  const host = '127.0.0.1' as const
  const manager = new SessionManager(options.defaultCli, options.stateDir)
  const sockets = new Set<ServerWebSocket<WebSocketData>>()
  const startedAt = Date.now()
  let shutdownPromise: Promise<void> | null = null

  const publish = (event: DesktopEvent) => {
    const serialized = JSON.stringify(event)
    for (const socket of sockets) {
      if (socket.data.sessionId && socket.data.sessionId !== event.sessionId) {
        continue
      }
      const lastCursor = socket.data.lastCursorBySession.get(event.sessionId)
      if (!isAfterCursor(event, lastCursor)) continue
      if (socket.data.replaying) {
        if (socket.data.buffered.length >= MAX_REPLAY_BUFFER_EVENTS) {
          socket.close(1013, 'event replay buffer exceeded')
          continue
        }
        socket.data.buffered.push(event)
        continue
      }
      if (socket.getBufferedAmount() > MAX_SOCKET_BUFFERED_BYTES) {
        socket.close(1013, 'event delivery backpressure')
        continue
      }
      socket.data.lastCursorBySession.set(event.sessionId, {
        generation: event.generation,
        seq: event.seq,
      })
      socket.send(serialized)
    }
  }
  const unsubscribe = manager.subscribe(publish)

  let server: ReturnType<typeof Bun.serve<WebSocketData>>
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      unsubscribe()
      await manager.shutdown()
      for (const socket of sockets) socket.close(1001, 'service shutdown')
      sockets.clear()
      server.stop(true)
    })()
    return shutdownPromise
  }

  const createServer = (port: number) => Bun.serve<WebSocketData>({
    hostname: host,
    port,
    async fetch(request, bunServer) {
      const url = new URL(request.url)
      if (!isAuthorized(request, options.token)) {
        return jsonResponse(
          rpcFailure('', 'UNAUTHORIZED', '需要 Bearer 认证') as unknown as JsonValue,
          401,
        )
      }

      if (url.pathname === '/v1/events') {
        const parsedAfterSeq = Number(url.searchParams.get('afterSeq') ?? '0')
        let cursors: Map<string, SessionEventCursor>
        try {
          cursors = parseCursorQuery(url.searchParams.get('cursors'))
        } catch (error) {
          return jsonResponse(
            rpcFailure(
              '',
              'INVALID_CURSOR',
              error instanceof Error ? error.message : 'cursor 参数无效',
            ) as unknown as JsonValue,
            400,
          )
        }
        const upgraded = bunServer.upgrade(request, {
          data: {
            ...(url.searchParams.get('sessionId')
              ? { sessionId: url.searchParams.get('sessionId')! }
              : {}),
            afterSeq:
              Number.isFinite(parsedAfterSeq) && parsedAfterSeq >= 0
                ? Math.floor(parsedAfterSeq)
                : 0,
            cursors,
            lastCursorBySession: new Map(cursors),
            replaying: true,
            buffered: [],
          },
        })
        return upgraded
          ? undefined
          : jsonResponse(
              rpcFailure('', 'UPGRADE_FAILED', 'WebSocket 升级失败') as unknown as JsonValue,
              400,
            )
      }

      if (url.pathname !== '/v1/rpc' || request.method !== 'POST') {
        return jsonResponse(
          rpcFailure('', 'NOT_FOUND', '接口不存在') as unknown as JsonValue,
          404,
        )
      }
      const contentLength = Number(request.headers.get('content-length') ?? '0')
      if (contentLength > MAX_RPC_BODY_BYTES) {
        return jsonResponse(
          rpcFailure('', 'BODY_TOO_LARGE', 'RPC 请求体过大') as unknown as JsonValue,
          413,
        )
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return jsonResponse(
          rpcFailure('', 'INVALID_JSON', 'RPC 请求不是合法 JSON') as unknown as JsonValue,
          400,
        )
      }
      const rpc = parseRpcRequest(body)
      if (!rpc) {
        return jsonResponse(
          rpcFailure('', 'INVALID_REQUEST', 'RPC 请求格式无效') as unknown as JsonValue,
          400,
        )
      }
      const response = await handleRpc(rpc, {
        manager,
        startedAt,
        serviceVersion: SERVICE_VERSION,
        shutdown,
      })
      return jsonResponse(response as unknown as JsonValue)
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        void (async () => {
          const replay = await manager.replayWithCursors(
            socket.data.sessionId,
            socket.data.cursors,
            socket.data.afterSeq,
          )
          const buffered = socket.data.buffered.splice(0)
          const ordered = [...replay, ...buffered].sort(compareDesktopEvents)
          for (const event of ordered) {
            const lastCursor = socket.data.lastCursorBySession.get(
              event.sessionId,
            )
            if (!isAfterCursor(event, lastCursor)) continue
            if (socket.getBufferedAmount() > MAX_SOCKET_BUFFERED_BYTES) {
              socket.close(1013, 'event replay backpressure')
              return
            }
            socket.data.lastCursorBySession.set(event.sessionId, {
              generation: event.generation,
              seq: event.seq,
            })
            socket.send(JSON.stringify(event))
          }
          socket.data.replaying = false
        })()
      },
      message(socket, message) {
        if (message === 'ping') socket.send('pong')
      },
      close(socket) {
        sockets.delete(socket)
      },
    },
  })

  const requestedPort = options.port ?? 0
  if (requestedPort > 0) {
    server = createServer(requestedPort)
  } else {
    let lastError: unknown
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = 49_152 + Math.floor(Math.random() * 16_383)
      try {
        server = createServer(candidate)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!server!) {
      unsubscribe()
      throw lastError ?? new Error('无法分配本地服务端口')
    }
  }

  const ready: LocalServiceReady = {
    type: 'local_service_ready',
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    host,
    port: Number(server.port),
  }
  return { host, port: Number(server.port), ready, manager, shutdown }
}
