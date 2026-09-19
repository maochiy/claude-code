import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

/** Main 与本地服务唯一的传输边界，不向 Renderer 暴露认证信息。 */
export interface LocalServiceEvent {
  type: 'desktop_event'
  protocolVersion: number
  eventId: string
  sessionId: string
  generation: number
  seq: number
  timestamp: number
  source: 'service' | 'cli'
  kind: string
  runId?: string
  requestId?: string
  payload: Record<string, unknown>
}

export class LocalServiceClient {
  private socket?: WebSocket
  private disposed = false
  private readonly listeners = new Set<(event: LocalServiceEvent) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private readonly cursors = new Map<string, { generation: number; seq: number }>()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0

  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.disposed) throw new Error('本地执行服务已关闭')
    const id = randomUUID()
    const response = await fetch(`${this.baseUrl}/v1/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.timeout(120_000),
    })
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') throw new Error('本地服务返回了无效响应')
    const rpc = body as { id?: string; ok?: boolean; result?: T; error?: { message?: string; code?: string } }
    if (rpc.id !== id) throw new Error('本地服务响应关联不匹配')
    if (!response.ok || rpc.ok !== true) throw new Error(rpc.error?.message || `本地服务请求失败 (${response.status})`)
    return rpc.result as T
  }

  subscribe(listener: (event: LocalServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('本地执行服务已关闭'))
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl.replace(/^http/, 'ws')}/v1/events`)
      if (this.cursors.size) url.searchParams.set('cursors', JSON.stringify(Object.fromEntries(this.cursors)))
      const socket = new WebSocket(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      })
      this.socket = socket
      let deliveryFailed = false
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('本地服务事件连接超时')) }, 10_000)
      socket.once('open', () => {
        clearTimeout(timer)
        this.reconnectAttempt = 0
        resolve()
      })
      socket.once('error', (error) => { clearTimeout(timer); reject(error) })
      socket.on('message', (data) => {
        if (deliveryFailed) return
        let event: LocalServiceEvent
        try {
          event = JSON.parse(data.toString()) as LocalServiceEvent
          if (event.type !== 'desktop_event' || !Number.isInteger(event.seq)
            || !Number.isInteger(event.generation) || typeof event.sessionId !== 'string') return
        } catch {
          console.warn('[本地服务] 忽略无效事件')
          return
        }
        try {
          const previous = this.cursors.get(event.sessionId)
          if (previous && (event.generation < previous.generation
            || (event.generation === previous.generation && event.seq <= previous.seq))) return
          for (const listener of this.listeners) listener(event)
          // 只有投影与持久化消费者都处理成功后才推进游标。
          this.cursors.set(event.sessionId, { generation: event.generation, seq: event.seq })
        } catch {
          deliveryFailed = true
          console.warn('[本地服务] 事件处理失败，将从未确认游标恢复')
          socket.close()
        }
      })
      socket.on('close', () => {
        clearTimeout(timer)
        if (this.disposed) return
        this.reconnectTimer = setTimeout(() => {
          void this.connect().catch(() => {})
        }, Math.min(500 * 2 ** this.reconnectAttempt++, 10_000))
      })
    })
  }

  dispose(error?: Error): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
    if (error) {
      for (const listener of this.failureListeners) {
        try { listener(error) } catch { /* 一个消费者失败不影响其他会话结束。 */ }
      }
    }
    this.listeners.clear()
    this.failureListeners.clear()
  }
}
