import { afterEach, describe, expect, test } from 'bun:test'
import type {
  DesktopEvent,
  JsonValue,
  RpcResponse,
} from '@proma/desktop-protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLocalService, type LocalServiceHandle } from '../src/index.ts'
import { SessionEventStore } from '../src/event-store.ts'
import {
  compareDesktopEvents,
  SessionManager,
} from '../src/session-manager.ts'

const fixture = join(import.meta.dir, 'fixtures', 'fake-cli.ts')
const serviceEntry = join(import.meta.dir, '..', 'src', 'index.ts')
const token = 'test-token-that-is-never-logged'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(item => item()))
})

async function rpc(
  service: LocalServiceHandle,
  method: string,
  params?: JsonValue,
): Promise<RpcResponse> {
  const response = await fetch(`http://${service.host}:${service.port}/v1/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: crypto.randomUUID(), method, params }),
  })
  return (await response.json()) as RpcResponse
}

function expectSuccess(response: RpcResponse): JsonValue {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('eventually timed out')
    await Bun.sleep(10)
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'xcodes-local-service-'))
  const outputPath = join(root, 'task-output.txt')
  const service = startLocalService({
    token,
    stateDir: join(root, 'state'),
    defaultCli: {
      command: process.execPath,
      argv: ['run', fixture],
      env: { FAKE_TASK_OUTPUT_PATH: outputPath },
    },
  })
  cleanup.push(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return { root, outputPath, service }
}

function connectEvents(
  service: LocalServiceHandle,
  sessionId?: string,
  cursors?: Record<string, { generation: number; seq: number }>,
) {
  const events: DesktopEvent[] = []
  const AuthenticatedWebSocket = WebSocket as unknown as {
    new (
      url: string,
      options: { headers: Record<string, string> },
    ): WebSocket
  }
  const query = new URLSearchParams({ afterSeq: '0' })
  if (sessionId) query.set('sessionId', sessionId)
  if (cursors) query.set('cursors', JSON.stringify(cursors))
  const socket = new AuthenticatedWebSocket(
    `ws://${service.host}:${service.port}/v1/events?${query.toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      events.push(JSON.parse(event.data) as DesktopEvent)
    }
  })
  cleanup.push(async () => socket.close())
  return { socket, events }
}

describe('Local Service BDD', () => {
  test('Bearer 鉴权、ready 握手和重复 open 配置保护', async () => {
    const { root, service } = await setup()
    const unauthorized = await fetch(
      `http://${service.host}:${service.port}/v1/rpc`,
      { method: 'POST', body: '{}' },
    )
    expect(unauthorized.status).toBe(401)
    const unauthorizedSocket = new WebSocket(
      `ws://${service.host}:${service.port}/v1/events`,
    )
    const unauthorizedClosed = new Promise<void>(resolve => {
      unauthorizedSocket.addEventListener('close', () => resolve(), {
        once: true,
      })
      unauthorizedSocket.addEventListener('error', () => resolve(), {
        once: true,
      })
    })
    await unauthorizedClosed
    expect(service.ready.protocolVersion).toBe(1)

    const invalidCursor = await fetch(
      `http://${service.host}:${service.port}/v1/events?cursors=%7Binvalid`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(invalidCursor.status).toBe(400)
    const invalidCursorBody = (await invalidCursor.json()) as RpcResponse
    expect(invalidCursorBody.ok).toBe(false)
    if (!invalidCursorBody.ok) {
      expect(invalidCursorBody.error.code).toBe('INVALID_CURSOR')
    }

    const opened = expectSuccess(
      await rpc(service, 'session.open', { sessionId: 's1', cwd: root }),
    ) as { generation: number }
    expect(opened.generation).toBe(1)
    expectSuccess(
      await rpc(service, 'session.control', {
        sessionId: 's1',
        requestId: 'initialize-once',
        subtype: 'initialize',
        payload: {},
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('s1')).events.some(
        event =>
          event.kind === 'control_resolved' &&
          event.requestId === 'initialize-once',
      ),
    )
    const initializePending = (await service.manager.snapshot('s1')).events.filter(
      event =>
        event.kind === 'control_pending' &&
        (event.payload as { subtype?: string }).subtype === 'initialize',
    )
    expect(initializePending).toHaveLength(1)
    const same = expectSuccess(
      await rpc(service, 'session.open', { sessionId: 's1', cwd: root }),
    ) as { generation: number }
    expect(same.generation).toBe(1)
    const conflict = await rpc(service, 'session.open', {
      sessionId: 's1',
      cwd: root,
      model: 'different',
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.error.code).toBe('SESSION_CONFIG_CONFLICT')
  })

  test('流式半包、Unicode、后台任务、日志读取和事件 replay', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    const { socket, events } = connectEvents(service, 's1')
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      })
    })

    const firstAccepted = expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'request-1',
        runId: 'run-1',
        content: 'background 中文',
      }),
    )
    const duplicateAccepted = expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'request-1',
        runId: 'different-run-must-not-send',
        content: 'duplicate must not reach CLI',
      }),
    )
    expect(duplicateAccepted).toEqual(firstAccepted)
    await eventually(() =>
      events.some(
        event =>
          event.kind === 'run_state' &&
          (event.payload as { state?: string }).state === 'completed',
      ),
    )
    expect(
      events.some(
        event =>
          event.kind === 'cli_message' &&
          JSON.stringify(event.payload).includes('回复：background 中文'),
      ),
    ).toBe(true)
    expect(
      events.filter(
        event =>
          event.kind === 'cli_message' &&
          (event.payload as { type?: string }).type === 'user',
      ),
    ).toHaveLength(1)
    expect(
      events.some(
        event =>
          event.kind === 'task_state' &&
          (event.payload as { state?: string }).state === 'completed',
      ),
    ).toBe(true)

    const output = expectSuccess(
      await rpc(service, 'task.output', {
        sessionId: 's1',
        taskId: 'task-1',
        offset: 0,
      }),
    ) as { content: string; eof: boolean }
    expect(output.content).toContain('中文 output')
    expect(output.eof).toBe(true)
    const lastSeq = Math.max(...events.map(event => event.seq))
    socket.close()
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'request-2',
        runId: 'run-2',
        content: 'second',
      }),
    )
    await eventually(async () => {
      const snapshot = await service.manager.snapshot('s1')
      return snapshot.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'run-2' &&
          (event.payload as { state?: string }).state === 'completed',
      )
    })
    const replay = await service.manager.replay('s1', lastSeq)
    expect(replay.length).toBeGreaterThan(0)
    expect(replay.every(event => event.seq > lastSeq)).toBe(true)

    const blocks: JsonValue = [
      { type: 'text', text: '看图' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
    ]
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'image-blocks',
        runId: 'image-blocks',
        content: blocks,
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('s1')).events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'image-blocks' &&
          (event.payload as { state?: string }).state === 'completed',
      ),
    )
    const imageReplay = (await service.manager.snapshot('s1')).events.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { type?: string }).type === 'user' &&
        Array.isArray(
          (
            event.payload as {
              message?: { content?: JsonValue }
            }
          ).message?.content,
        ),
    )
    expect(
      (
        imageReplay?.payload as {
          message?: { content?: JsonValue }
        }
      ).message?.content,
    ).toEqual(blocks)
  })

  test('带 interrupt 的 send 原子插到队首且重复 requestId 不会重复中断', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'atomic-active',
        runId: 'atomic-active',
        content: 'hang',
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('s1')).activeRunId === 'atomic-active',
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'atomic-old-queued',
        runId: 'atomic-old-queued',
        content: 'old queued message',
      }),
    )
    const urgentParams = {
      sessionId: 's1',
      requestId: 'atomic-urgent-request',
      runId: 'atomic-urgent',
      content: 'urgent message',
      interrupt: true,
    }
    const first = expectSuccess(await rpc(service, 'session.send', urgentParams))
    const duplicate = expectSuccess(await rpc(service, 'session.send', urgentParams))
    expect(duplicate).toEqual(first)

    await eventually(async () => {
      const snapshot = await service.manager.snapshot('s1')
      return snapshot.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'atomic-old-queued' &&
          (event.payload as { state?: string }).state === 'completed',
      )
    })
    const events = (await service.manager.snapshot('s1')).events
    const runningOrder = events
      .filter(
        event =>
          event.kind === 'run_state' &&
          (event.payload as { state?: string }).state === 'running',
      )
      .map(event => event.runId)
      .filter(runId => runId?.startsWith('atomic-'))
    expect(runningOrder).toEqual([
      'atomic-active',
      'atomic-urgent',
      'atomic-old-queued',
    ])
    expect(
      events.filter(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'atomic-urgent' &&
          (event.payload as { state?: string }).state === 'queued',
      ),
    ).toHaveLength(1)
    expect(
      events.filter(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'atomic-active' &&
          (event.payload as { state?: string }).state === 'interrupted',
      ),
    ).toHaveLength(1)
  })

  test('真实 CLI 仅发送 result 时结算前台轮次并继续派发队列', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'terminal-result-1',
        runId: 'terminal-result-1',
        content: 'result without idle',
      }),
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'terminal-result-2',
        runId: 'terminal-result-2',
        content: 'second after terminal result',
      }),
    )
    await eventually(async () => {
      const snapshot = await service.manager.snapshot('s1')
      return snapshot.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'terminal-result-2' &&
          (event.payload as { state?: string }).state === 'completed',
      )
    })
    const snapshot = await service.manager.snapshot('s1')
    const firstResult = snapshot.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === 'terminal-result-1' &&
        (event.payload as { type?: string }).type === 'result',
    )
    const secondRunning = snapshot.events.find(
      event =>
        event.kind === 'run_state' &&
        event.runId === 'terminal-result-2' &&
        (event.payload as { state?: string }).state === 'running',
    )
    expect(firstResult).toBeDefined()
    expect(secondRunning).toBeDefined()
    expect(snapshot.state).toBe('idle')
  })

  test('CLI 崩溃时当前轮次与排队轮次均失败，且不会向已关闭 stdin 派发', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    for (const [requestId, content] of [
      ['crashing-run', 'crash process'],
      ['queued-after-crash', 'must not dispatch'],
    ] as const) {
      expectSuccess(
        await rpc(service, 'session.send', {
          sessionId: 's1',
          requestId,
          runId: requestId,
          content,
        }),
      )
    }
    await eventually(async () =>
      (await service.manager.snapshot('s1')).state === 'crashed',
    )
    const snapshot = await service.manager.snapshot('s1')
    for (const runId of ['crashing-run', 'queued-after-crash']) {
      expect(
        snapshot.events.some(
          event =>
            event.kind === 'run_state' &&
            event.runId === runId &&
            (event.payload as { state?: string }).state === 'failed',
        ),
      ).toBe(true)
    }
    expect(
      snapshot.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'queued-after-crash' &&
          (event.payload as { state?: string }).state === 'running',
      ),
    ).toBe(false)
  })

  test('权限请求可恢复结算，队列逐轮派发且 interrupt 不结束进程', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    const { socket, events } = connectEvents(service, 's1')
    await new Promise<void>(resolve =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    )

    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'permission-run',
        runId: 'permission-run',
        content: 'permission',
      }),
    )
    await eventually(() =>
      events.some(
        event =>
          event.kind === 'control_pending' &&
          (event.payload as { direction?: string }).direction === 'cli_to_host',
      ),
    )
    const snapshot = await service.manager.snapshot('s1')
    expect(snapshot.pendingControls).toHaveLength(1)
    const cliRequestId = snapshot.pendingControls[0]!.cliRequestId
    expectSuccess(
      await rpc(service, 'session.respond', {
        sessionId: 's1',
        requestId: 'allow-1',
        cliRequestId,
        response: { behavior: 'allow', updatedInput: { command: 'printf safe' } },
      }),
    )
    await eventually(() =>
      events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'permission-run' &&
          (event.payload as { state?: string }).state === 'completed',
      ),
    )
    expect(
      events.some(
        event =>
          event.kind === 'control_resolved' &&
          (event.payload as { direction?: string; outcome?: string })
            .direction === 'cli_to_host' &&
          (event.payload as { outcome?: string }).outcome === 'success',
      ),
    ).toBe(true)

    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'hang',
        runId: 'hang',
        content: 'hang',
      }),
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'queued',
        runId: 'queued',
        content: 'after interrupt',
      }),
    )
    expectSuccess(
      await rpc(service, 'session.interrupt', {
        sessionId: 's1',
        requestId: 'interrupt-1',
        runId: 'hang',
      }),
    )
    await eventually(() =>
      events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === 'queued' &&
          (event.payload as { state?: string }).state === 'completed',
      ),
    )
    expect((await service.manager.snapshot('s1')).state).toBe('idle')

    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'two-tasks',
        runId: 'two-tasks',
        content: 'two tasks',
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('s1')).tasks.length === 2,
    )
    expectSuccess(
      await rpc(service, 'task.stop', {
        sessionId: 's1',
        taskId: 'task-1',
        requestId: 'stop-task-1',
      }),
    )
    await eventually(async () => {
      const tasks = (await service.manager.snapshot('s1')).tasks
      return tasks.find(task => task.taskId === 'task-1')?.state === 'stopped'
    })
    const tasks = (await service.manager.snapshot('s1')).tasks
    expect(tasks.find(task => task.taskId === 'task-1')?.state).toBe('stopped')
    expect(tasks.find(task => task.taskId === 'task-2')?.state).toBe('running')

    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 's1',
        requestId: 'cancel-control',
        runId: 'cancel-control',
        content: 'cancel control',
      }),
    )
    await eventually(() =>
      events.some(
        event =>
          event.kind === 'control_resolved' &&
          event.runId === 'cancel-control' &&
          (event.payload as { outcome?: string }).outcome === 'cancelled',
      ),
    )
    expect((await service.manager.snapshot('s1')).pendingControls).toHaveLength(0)
  })

  test('独立服务进程输出 ready 握手并可通过 RPC 有序退出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcodes-local-service-process-'))
    const childToken = 'child-process-token'
    const child = Bun.spawn([process.execPath, 'run', serviceEntry], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        XCODES_LOCAL_SERVICE_TOKEN: childToken,
        XCODES_CLI_COMMAND: process.execPath,
        XCODES_CLI_ARGV_JSON: JSON.stringify(['run', fixture]),
        XCODES_CLI_ENV_JSON: JSON.stringify({
          FAKE_TASK_OUTPUT_PATH: join(root, 'task.txt'),
        }),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    cleanup.push(async () => {
      child.kill()
      await child.exited.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let ready: { host: string; port: number } | null = null
    const deadline = Date.now() + 3_000
    while (!ready && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      const newline = buffered.indexOf('\n')
      if (newline >= 0) {
        ready = JSON.parse(buffered.slice(0, newline)) as {
          host: string
          port: number
        }
      }
    }
    reader.releaseLock()
    expect(ready).not.toBeNull()
    if (!ready) throw new Error('service ready timeout')

    const call = async (method: string) => {
      const response = await fetch(
        `http://${ready!.host}:${ready!.port}/v1/rpc`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${childToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ id: crypto.randomUUID(), method }),
        },
      )
      return (await response.json()) as RpcResponse
    }
    const health = expectSuccess(await call('service.health')) as {
      protocolVersion: number
      capabilities: string[]
    }
    expect(health.protocolVersion).toBe(1)
    expect(health.capabilities).toContain('replay')
    expect(health.capabilities).toContain('tasks')
    expectSuccess(await call('service.shutdown'))
    expect(await child.exited).toBe(0)
  })

  test('断线超过内存窗口后从 JSONL journal 完整 replay，不伪装成连续流', async () => {
    const { root, service } = await setup()
    expectSuccess(await rpc(service, 'session.open', { sessionId: 's1', cwd: root }))
    for (let index = 0; index < 2_100; index += 1) {
      service.manager.control({
        sessionId: 's1',
        requestId: `control-${index}`,
        subtype: 'set_model',
        payload: { model: `fake-${index}` },
      })
    }
    const snapshot = await service.manager.snapshot('s1', 0)
    expect(snapshot.replay.truncated).toBe(false)
    expect(snapshot.events[0]?.seq).toBe(1)
    expect(snapshot.events.length).toBeGreaterThan(2_000)

    const { socket, events } = connectEvents(service, 's1')
    await new Promise<void>(resolve =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    )
    const targetSeq = snapshot.seq
    await eventually(
      () => (events.at(-1)?.seq ?? 0) >= targetSeq,
      10_000,
    )
    expect(events[0]?.seq).toBe(1)
    expect(new Set(events.map(event => event.eventId)).size).toBe(events.length)
  })

  test('全会话 WebSocket 按 generation/seq 独立续传且新代不会被旧游标吞掉', async () => {
    const { root, service } = await setup()
    for (const sessionId of ['cursor-a', 'cursor-b']) {
      expectSuccess(await rpc(service, 'session.open', { sessionId, cwd: root }))
      await eventually(async () =>
        (await service.manager.snapshot(sessionId)).events.some(
          event =>
            event.kind === 'cli_message' &&
            (event.payload as { subtype?: string }).subtype === 'init',
        ),
      )
    }
    const beforeA = await service.manager.snapshot('cursor-a')
    const beforeB = await service.manager.snapshot('cursor-b')
    const cursors = {
      'cursor-a': { generation: beforeA.generation, seq: beforeA.seq },
      'cursor-b': { generation: beforeB.generation, seq: beforeB.seq },
    }
    service.manager.control({
      sessionId: 'cursor-a',
      requestId: 'cursor-a-model',
      subtype: 'set_model',
      payload: { model: 'next-a' },
    })
    service.manager.control({
      sessionId: 'cursor-b',
      requestId: 'cursor-b-model',
      subtype: 'set_model',
      payload: { model: 'next-b' },
    })

    const resumed = connectEvents(service, undefined, cursors)
    await new Promise<void>(resolve =>
      resumed.socket.addEventListener('open', () => resolve(), { once: true }),
    )
    await eventually(
      () =>
        resumed.events.some(event => event.sessionId === 'cursor-a') &&
        resumed.events.some(event => event.sessionId === 'cursor-b'),
    )
    expect(
      resumed.events.every(event => {
        const cursor = cursors[event.sessionId as keyof typeof cursors]
        return (
          !cursor ||
          event.generation > cursor.generation ||
          (event.generation === cursor.generation && event.seq > cursor.seq)
        )
      }),
    ).toBe(true)
    resumed.socket.close()

    await service.manager.close('cursor-a')
    expectSuccess(await rpc(service, 'session.open', { sessionId: 'cursor-a', cwd: root }))
    const reopened = await service.manager.snapshot('cursor-a')
    expect(reopened.generation).toBe(beforeA.generation + 1)
    const nextGeneration = connectEvents(service, 'cursor-a', {
      'cursor-a': { generation: beforeA.generation, seq: 999_999 },
    })
    await new Promise<void>(resolve =>
      nextGeneration.socket.addEventListener('open', () => resolve(), {
        once: true,
      }),
    )
    await eventually(() => nextGeneration.events.length > 0)
    expect(
      nextGeneration.events.every(
        event => event.generation === reopened.generation,
      ),
    ).toBe(true)
  })

  test('generation 从同一 stateDir 的 journal 延续，服务重启后不倒退', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcodes-generation-restart-'))
    const stateDir = join(root, 'state')
    const createService = () =>
      startLocalService({
        token,
        stateDir,
        defaultCli: {
          command: process.execPath,
          argv: ['run', fixture],
          env: { FAKE_TASK_OUTPUT_PATH: join(root, 'task-output.txt') },
        },
      })
    const first = createService()
    expectSuccess(
      await rpc(first, 'session.open', { sessionId: 'persistent-generation', cwd: root }),
    )
    expect((await first.manager.snapshot('persistent-generation')).generation).toBe(1)
    await first.shutdown()

    const second = createService()
    cleanup.push(async () => {
      await second.shutdown()
      await rm(root, { recursive: true, force: true })
    })
    expectSuccess(
      await rpc(second, 'session.open', { sessionId: 'persistent-generation', cwd: root }),
    )
    expect((await second.manager.snapshot('persistent-generation')).generation).toBe(2)
  })

  test('fork 与 rewind resume 使用原生 CLI 参数并写入正确 session_id', async () => {
    const { root, service } = await setup()
    const original = '11111111-1111-4111-8111-111111111111'
    const forked = 'desktop-fork-session'
    const forkedNative = '22222222-2222-4222-8222-222222222222'
    expectSuccess(
      await rpc(service, 'session.open', {
        sessionId: forked,
        nativeSessionId: forkedNative,
        cwd: root,
        resumeSessionId: original,
        forkSession: true,
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot(forked)).events.some(
        event =>
          event.kind === 'cli_message' &&
          (event.payload as { subtype?: string }).subtype === 'init',
      ),
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: forked,
        requestId: 'fork-message',
        content: 'forked',
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot(forked)).state === 'idle',
    )
    const forkEvents = (await service.manager.snapshot(forked)).events
    const forkInit = forkEvents.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { subtype?: string }).subtype === 'init',
    )
    const forkArgs = (forkInit?.payload as { launch_args?: string[] })
      .launch_args
    expect(forkArgs).toContain('--resume')
    expect(forkArgs).toContain(original)
    expect(forkArgs).toContain('--fork-session')
    expect(forkArgs).toContain(forkedNative)
    expect(forkArgs).not.toContain(forked)
    const forkUser = forkEvents.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { type?: string }).type === 'user',
    )
    expect((forkUser?.payload as { session_id?: string }).session_id).toBe(
      forkedNative,
    )

    await service.manager.close(forked)
    const resumeAt = '33333333-3333-4333-8333-333333333333'
    expectSuccess(
      await rpc(service, 'session.open', {
        sessionId: 'desktop-resume',
        cwd: root,
        resumeSessionId: original,
        resumeSessionAt: resumeAt,
      }),
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 'desktop-resume',
        requestId: 'resume-message',
        content: 'resumed',
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('desktop-resume')).state === 'idle',
    )
    const resumeEvents = (await service.manager.snapshot('desktop-resume')).events
    const resumeInit = resumeEvents.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { subtype?: string }).subtype === 'init',
    )
    const resumeArgs = (resumeInit?.payload as { launch_args?: string[] })
      .launch_args
    expect(resumeArgs).toContain('--resume-session-at')
    expect(resumeArgs).toContain(resumeAt)
    expect(resumeArgs).not.toContain('--fork-session')
    const resumeUser = resumeEvents.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { type?: string }).type === 'user',
    )
    expect((resumeUser?.payload as { session_id?: string }).session_id).toBe(
      original,
    )
  })

  test('desktop sessionId 与 fresh nativeSessionId 独立映射并校验 UUID', async () => {
    const { root, service } = await setup()
    const nativeSessionId = '44444444-4444-4444-8444-444444444444'
    expectSuccess(
      await rpc(service, 'session.open', {
        sessionId: 'desktop-clear-generation-2',
        nativeSessionId,
        cwd: root,
      }),
    )
    expectSuccess(
      await rpc(service, 'session.send', {
        sessionId: 'desktop-clear-generation-2',
        requestId: 'native-session-message',
        content: 'fresh native session',
      }),
    )
    await eventually(async () =>
      (await service.manager.snapshot('desktop-clear-generation-2')).state === 'idle',
    )
    const events = (await service.manager.snapshot('desktop-clear-generation-2')).events
    const init = events.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { subtype?: string }).subtype === 'init',
    )
    const launchArgs = (init?.payload as { launch_args?: string[] }).launch_args
    expect(launchArgs).toContain(nativeSessionId)
    const user = events.find(
      event =>
        event.kind === 'cli_message' &&
        (event.payload as { type?: string }).type === 'user',
    )
    expect((user?.payload as { session_id?: string }).session_id).toBe(
      nativeSessionId,
    )

    const nativeConflict = await rpc(service, 'session.open', {
      sessionId: 'desktop-clear-generation-2',
      nativeSessionId: '55555555-5555-4555-8555-555555555555',
      cwd: root,
    })
    expect(nativeConflict.ok).toBe(false)
    if (!nativeConflict.ok) {
      expect(nativeConflict.error.code).toBe('SESSION_CONFIG_CONFLICT')
    }

    const invalid = await rpc(service, 'session.open', {
      sessionId: 'desktop-invalid-native',
      nativeSessionId: 'not-a-uuid',
      cwd: root,
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_PARAMS')
  })

  test('空闲会话按 LRU 容量和 TTL 安全回收，并在删除前发送关闭事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idle-eviction-'))
    let now = 1_000
    const manager = new SessionManager(
      {
        command: process.execPath,
        argv: ['run', fixture],
        env: { FAKE_TASK_OUTPUT_PATH: join(root, 'task-output.txt') },
      },
      join(root, 'state'),
      {
        idleTtlMs: 1_000,
        maxIdleSessions: 1,
        sweepIntervalMs: 0,
        now: () => now,
      },
    )
    const events: DesktopEvent[] = []
    manager.subscribe(event => events.push(event))
    cleanup.push(async () => {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    })

    await manager.open({ sessionId: 'idle-oldest', cwd: root })
    await eventually(async () =>
      (await manager.snapshot('idle-oldest')).state === 'ready',
    )
    now = 1_100
    await manager.open({ sessionId: 'idle-newest', cwd: root })
    await eventually(async () =>
      (await manager.snapshot('idle-newest')).state === 'ready',
    )

    expect(await manager.sweepIdleSessions()).toEqual(['idle-oldest'])
    expect((await manager.list()).map(item => item.sessionId)).toEqual([
      'idle-newest',
    ])
    expect(
      events.some(
        event =>
          event.sessionId === 'idle-oldest' &&
          event.kind === 'process_state' &&
          (event.payload as { state?: string; reason?: string }).state ===
            'stopped' &&
          (event.payload as { reason?: string }).reason === 'idle_capacity',
      ),
    ).toBe(true)

    now = 2_101
    expect(await manager.sweepIdleSessions()).toEqual(['idle-newest'])
    expect(manager.size).toBe(0)
    expect(
      events.some(
        event =>
          event.sessionId === 'idle-newest' &&
          event.kind === 'process_state' &&
          (event.payload as { state?: string; reason?: string }).state ===
            'stopped' &&
          (event.payload as { reason?: string }).reason === 'idle_timeout',
      ),
    ).toBe(true)
  })

  test('活跃、排队、审批和后台任务会话不会被空闲回收', async () => {
    const root = await mkdtemp(join(tmpdir(), 'busy-retention-'))
    let now = 10_000
    const manager = new SessionManager(
      {
        command: process.execPath,
        argv: ['run', fixture],
        env: { FAKE_TASK_OUTPUT_PATH: join(root, 'task-output.txt') },
      },
      join(root, 'state'),
      {
        idleTtlMs: 100,
        maxIdleSessions: 0,
        sweepIntervalMs: 0,
        now: () => now,
      },
    )
    cleanup.push(async () => {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
    })

    for (const sessionId of ['busy-queue', 'busy-approval', 'busy-task']) {
      await manager.open({ sessionId, cwd: root })
      await eventually(async () =>
        (await manager.snapshot(sessionId)).state === 'ready',
      )
    }
    manager.send({
      sessionId: 'busy-queue',
      requestId: 'busy-active',
      runId: 'busy-active',
      content: 'hang',
    })
    manager.send({
      sessionId: 'busy-queue',
      requestId: 'busy-queued',
      runId: 'busy-queued',
      content: 'queued behind active',
    })
    manager.send({
      sessionId: 'busy-approval',
      requestId: 'busy-approval',
      runId: 'busy-approval',
      content: 'permission',
    })
    manager.send({
      sessionId: 'busy-task',
      requestId: 'busy-task',
      runId: 'busy-task',
      content: 'two tasks',
    })
    await eventually(async () => {
      const approval = await manager.snapshot('busy-approval')
      const task = await manager.snapshot('busy-task')
      return (
        approval.pendingControls.length === 1 &&
        task.tasks.some(item => item.state === 'running') &&
        task.state === 'idle'
      )
    })

    now = 20_000
    expect(await manager.sweepIdleSessions()).toEqual([])
    expect(
      (await manager.list()).map(item => item.sessionId).sort(),
    ).toEqual(['busy-approval', 'busy-queue', 'busy-task'])
    const queued = await manager.snapshot('busy-queue')
    expect(queued.activeRunId).toBe('busy-active')
    expect(
      queued.events.some(
        event =>
          event.runId === 'busy-queued' &&
          event.kind === 'run_state' &&
          (event.payload as { state?: string }).state === 'queued',
      ),
    ).toBe(true)
  })

  test('journal 不可用且旧 cursor 已越过 ring 时显式标记 truncated', async () => {
    const store = new SessionEventStore('session', 1, 2)
    for (let index = 0; index < 3; index += 1) {
      store.append({
        source: 'service',
        kind: 'process_state',
        payload: { index },
      })
    }
    const replay = await store.replay(0)
    expect(replay.truncated).toBe(true)
    expect(replay.oldestAvailableSeq).toBe(2)
    expect(replay.events.map(event => event.seq)).toEqual([2, 3])
  })

  test('同一毫秒内超过十条 replay 事件仍按数值 seq 顺序交付', async () => {
    const store = new SessionEventStore('same-millisecond', 2, 20)
    const originalNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      for (let index = 0; index < 12; index += 1) {
        store.append({
          source: 'service',
          kind: 'process_state',
          payload: { index },
        })
      }
    } finally {
      Date.now = originalNow
    }

    const replay = await store.replay(0)
    replay.events[10]!.timestamp -= 10_000
    const mergedReplay = [...replay.events].reverse().sort(compareDesktopEvents)
    expect(mergedReplay.map(event => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
  })

  test('混合会话发生时钟回拨时排序仍满足传递性并保留各会话 seq', async () => {
    const firstStore = new SessionEventStore('session-a', 3, 20)
    const secondStore = new SessionEventStore('session-b', 7, 20)
    for (let index = 0; index < 12; index += 1) {
      firstStore.append({
        source: 'service',
        kind: 'process_state',
        payload: { index },
      })
      secondStore.append({
        source: 'service',
        kind: 'process_state',
        payload: { index },
      })
    }
    const first = (await firstStore.replay(0)).events
    const second = (await secondStore.replay(0)).events
    first.forEach((event, index) => { event.timestamp = 1_000 - index * 10 })
    second.forEach((event, index) => { event.timestamp = 500 + index * 10 })

    const unordered = first.flatMap((event, index) => [
      second[second.length - 1 - index]!,
      event,
    ]).reverse()
    const ordered = unordered.sort(compareDesktopEvents)
    expect(ordered).toHaveLength(24)
    expect(ordered.filter(event => event.sessionId === 'session-a').map(event => event.seq))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(ordered.filter(event => event.sessionId === 'session-b').map(event => event.seq))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(new Set(ordered.map(event => event.eventId)).size).toBe(24)
  })
})
