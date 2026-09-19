import { describe, expect, test } from 'bun:test'
import { LocalServiceClient, type LocalServiceEvent } from './client'

function event(seq: number, generation = 1): LocalServiceEvent {
  return { type: 'desktop_event', protocolVersion: 1, eventId: `session:${generation}:${seq}`,
    sessionId: 'session', generation, seq, timestamp: 100, source: 'cli', kind: 'cli_message', payload: {} }
}

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待 Main 事件传输超时')
    await Bun.sleep(10)
  }
}

describe('Main loopback 事件传输', () => {
  test('服务进程意外退出时每个会话消费者立即收到一次故障，正常关闭不伪造故障', () => {
    const client = new LocalServiceClient('http://127.0.0.1:1', 'fixture')
    const errors: string[] = []
    client.subscribeFailure(error => errors.push(error.message))
    client.dispose(new Error('服务已退出'))
    client.dispose(new Error('重复退出'))
    expect(errors).toEqual(['服务已退出'])
    const normalClient = new LocalServiceClient('http://127.0.0.1:1', 'fixture')
    normalClient.subscribeFailure(error => errors.push(error.message))
    normalClient.dispose()
    expect(errors).toEqual(['服务已退出'])
  })
  test('消费者落盘失败后重连只推进成功游标，重放不重复消费已完成事件', async () => {
    const observedCursors: string[] = []
    const server = Bun.serve<{ cursor: string }>({
      hostname: '127.0.0.1', port: 0,
      fetch(request, currentServer) {
        if (request.headers.get('authorization') !== 'Bearer fixture') return new Response('', { status: 401 })
        const cursor = new URL(request.url).searchParams.get('cursors') ?? ''
        observedCursors.push(cursor)
        if (currentServer.upgrade(request, { data: { cursor } })) return
        return new Response('', { status: 400 })
      },
      websocket: {
        open(socket) { for (let seq = 1; seq <= 12; seq++) socket.send(JSON.stringify(event(seq))) },
        message() {},
      },
    })
    const client = new LocalServiceClient(`http://127.0.0.1:${server.port}`, 'fixture')
    const consumed: number[] = []
    let shouldFail = true
    client.subscribe(message => {
      if (message.seq === 2 && shouldFail) { shouldFail = false; throw new Error('fixture disk unavailable') }
      consumed.push(message.seq)
    })
    try {
      await client.connect()
      await eventually(() => consumed.length === 12)
      expect(consumed).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
      expect(JSON.parse(observedCursors[1]!)).toEqual({ session: { generation: 1, seq: 1 } })
    } finally {
      client.dispose()
      await server.stop(true)
    }
  })

  test('新进程代次允许序号重新从1开始，旧代次和重复事件不倒灌', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request, currentServer) {
        if (currentServer.upgrade(request)) return
        return new Response('', { status: 400 })
      },
      websocket: {
        open(socket) { for (const message of [event(50), event(1, 2), event(51), event(1, 2), event(2, 2)]) socket.send(JSON.stringify(message)) },
        message() {},
      },
    })
    const client = new LocalServiceClient(`http://127.0.0.1:${server.port}`, 'fixture')
    const consumed: string[] = []
    client.subscribe(message => consumed.push(`${message.generation}:${message.seq}`))
    try {
      await client.connect()
      await eventually(() => consumed.length === 3)
      expect(consumed).toEqual(['1:50', '2:1', '2:2'])
    } finally {
      client.dispose()
      await server.stop(true)
    }
  })
})
