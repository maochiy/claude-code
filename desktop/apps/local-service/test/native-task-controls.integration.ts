import { resolveNativeCliRoot } from './fixtures/native-cli-path.ts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type {
  CliLaunchSpec,
  DesktopEvent,
  JsonValue,
  RpcResponse,
  SessionSnapshot,
} from '@proma/desktop-protocol'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalService, type LocalServiceHandle } from '../src/index.ts'

const cliRoot = resolveNativeCliRoot()
const cliEntry = join(cliRoot, 'dist', 'cli-bun.js')
const token = 'native-task-controls-integration-token'

interface FakeAnthropicServer {
  baseUrl: string
  stop(): void
}

interface Fixture {
  root: string
  workspace: string
  service: LocalServiceHandle
  fakeApi: FakeAnthropicServer
}

interface TaskSnapshot {
  task_id: string
  task_type: string
  status: string
  description: string
  output_bytes: number
  output_available: boolean
  parent_task_id?: string
  child_task_ids: string[]
  agent_id?: string
  transcript_available: boolean
}

interface TranscriptPage {
  snapshotId: string
  messages: Record<string, JsonValue>[]
  cursor: number
  nextCursor: number
  total: number
  eof: boolean
}

let fixture: Fixture

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function sseEvent(event: string, data: JsonValue): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-native-task-controls-fixture',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

function textStream(text: string): string {
  return [
    messageStart(),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function backgroundTasksStream(): string {
  return toolsStream([
    {
      name: 'Bash',
      command: "printf '任务甲🙂开始\\n'; sleep 1; printf '任务甲完成\\n'",
      description: '运行 Unicode 后台任务甲',
      run_in_background: true,
    },
    {
      name: 'Bash',
      command: "printf '任务乙🙂开始\\n'; sleep 10; printf '任务乙不应完成\\n'",
      description: '运行待停止后台任务乙',
      run_in_background: true,
    },
  ])
}

function toolsStream(
  tools: Array<{ name: string } & Record<string, JsonValue>>,
): string {
  const blocks = tools.flatMap((tool, index) => [
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
        name: tool.name,
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(
          Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'name')),
        ),
      },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index }),
  ])
  return [
    messageStart(),
    ...blocks,
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 10 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function startFakeAnthropicServer(): FakeAnthropicServer {
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/count_tokens')) {
        return Response.json({ input_tokens: 12 })
      }
      if (!url.pathname.endsWith('/messages') || request.method !== 'POST') {
        return Response.json({ error: { message: 'not found' } }, { status: 404 })
      }
      const body = (await request.json()) as JsonValue
      const serialized = JSON.stringify(body)
      const scenario = /NATIVE_TASK_CONTROLS_[A-Z_]+/.exec(serialized)?.[0]
        ?? 'NATIVE_TASK_CONTROLS_UNKNOWN'
      const ordinal = (counts.get(scenario) ?? 0) + 1
      counts.set(scenario, ordinal)
      const events = scenario === 'NATIVE_TASK_CONTROLS_BACKGROUND' && ordinal === 1
        ? backgroundTasksStream()
        : scenario === 'NATIVE_TASK_CONTROLS_AGENT_PARENT' && ordinal === 1
          ? toolsStream([{
              name: 'Agent',
              subagent_type: 'general-purpose',
              description: '运行真实隔离子代理',
              prompt: 'NATIVE_TASK_CONTROLS_AGENT_CHILD 请执行隔离子任务',
              run_in_background: true,
            }])
          : scenario === 'NATIVE_TASK_CONTROLS_AGENT_CHILD' && ordinal === 1
            ? toolsStream([{
                name: 'Bash',
                command: "printf '子代理后台任务开始\\n'; sleep 1; printf '子代理后台任务完成\\n'",
                description: '运行子代理后台 Bash',
                run_in_background: true,
              }])
        : textStream(`隔离回复 ${scenario} 第 ${ordinal} 轮`)
      return new Response(events, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'request-id': `req_${crypto.randomUUID().replaceAll('-', '')}`,
        },
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

async function rpc(method: string, params?: JsonValue): Promise<RpcResponse> {
  const response = await fetch(
    `http://${fixture.service.host}:${fixture.service.port}/v1/rpc`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: crypto.randomUUID(), method, params }),
    },
  )
  return (await response.json()) as RpcResponse
}

function expectSuccess(response: RpcResponse): JsonValue {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待真实 CLI task control 超时：${JSON.stringify(value)}`)
    }
    await Bun.sleep(25)
    value = await read()
  }
  return value
}

function controlResponse(
  events: DesktopEvent[],
  requestId: string,
): Record<string, JsonValue> | null {
  const event = events.find(
    candidate =>
      candidate.kind === 'control_resolved'
      && candidate.requestId === requestId
      && isRecord(candidate.payload)
      && candidate.payload.direction === 'host_to_cli',
  )
  if (!event || !isRecord(event.payload)) return null
  const response = event.payload.response
  return response !== undefined && isRecord(response) ? response : null
}

async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  return fixture.service.manager.snapshot(sessionId)
}

async function openSession(params: {
  sessionId?: string
  nativeSessionId?: string
  resumeSessionId?: string
} = {}): Promise<{ sessionId: string; nativeSessionId: string }> {
  const sessionId = params.sessionId ?? crypto.randomUUID()
  const nativeSessionId = params.nativeSessionId ?? params.resumeSessionId ?? crypto.randomUUID()
  expectSuccess(await rpc('session.open', {
    sessionId,
    ...(params.resumeSessionId
      ? { resumeSessionId: params.resumeSessionId }
      : { nativeSessionId }),
    cwd: fixture.workspace,
    permissionMode: 'bypassPermissions',
    model: 'claude-native-task-controls-fixture',
  }))
  const requestId = `initialize-${crypto.randomUUID()}`
  expectSuccess(await rpc('session.control', {
    sessionId,
    requestId,
    subtype: 'initialize',
    payload: {},
  }))
  const current = await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, requestId) !== null,
  )
  expect(controlResponse(current.events, requestId)?.subtype).toBe('success')
  return { sessionId, nativeSessionId }
}

async function control(
  sessionId: string,
  subtype: string,
  payload: Record<string, JsonValue> = {},
): Promise<Record<string, JsonValue>> {
  const requestId = `${subtype}-${crypto.randomUUID()}`
  expectSuccess(await rpc('session.control', {
    sessionId,
    requestId,
    subtype,
    payload,
  }))
  const current = await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, requestId) !== null,
  )
  const response = controlResponse(current.events, requestId)
  if (!response) throw new Error(`控制请求没有响应：${subtype}`)
  if (response.subtype !== 'success') {
    throw new Error(`控制请求失败 ${subtype}：${String(response.error)}`)
  }
  const result = response.response
  if (result === undefined || !isRecord(result)) {
    throw new Error(`控制响应格式无效：${subtype}`)
  }
  return result
}

async function send(sessionId: string, content: string): Promise<string> {
  const runId = crypto.randomUUID()
  expectSuccess(await rpc('session.send', {
    sessionId,
    requestId: `send-${runId}`,
    runId,
    content,
  }))
  return runId
}

async function waitForCompleted(sessionId: string, runId: string): Promise<void> {
  await eventually(
    () => snapshot(sessionId),
    value => value.events.some(
      event => event.kind === 'run_state'
        && event.runId === runId
        && isRecord(event.payload)
        && event.payload.state === 'completed',
    ),
  )
}

function taskSnapshots(result: Record<string, JsonValue>): TaskSnapshot[] {
  const tasks = result.tasks
  if (!Array.isArray(tasks)) throw new Error('get_tasks 缺少 tasks 数组')
  return tasks.filter(isRecord).map(task => ({
    task_id: String(task.task_id),
    task_type: String(task.task_type),
    status: String(task.status),
    description: String(task.description),
    output_bytes: Number(task.output_bytes),
    output_available: Boolean(task.output_available),
    ...(typeof task.parent_task_id === 'string'
      ? { parent_task_id: task.parent_task_id }
      : {}),
    child_task_ids: Array.isArray(task.child_task_ids)
      ? task.child_task_ids.map(String)
      : [],
    ...(typeof task.agent_id === 'string' ? { agent_id: task.agent_id } : {}),
    transcript_available: Boolean(task.transcript_available),
  }))
}

function transcriptPage(result: Record<string, JsonValue>): TranscriptPage {
  if (!Array.isArray(result.messages)) throw new Error('transcript 缺少 messages')
  return {
    snapshotId: String(result.snapshot_id),
    messages: result.messages.filter(isRecord),
    cursor: Number(result.cursor),
    nextCursor: Number(result.next_cursor),
    total: Number(result.total),
    eof: Boolean(result.eof),
  }
}

async function readCompleteTaskOutput(
  sessionId: string,
  taskId: string,
): Promise<string> {
  let cursor = 0
  let content = ''
  for (let page = 0; page < 128; page += 1) {
    const result = await control(sessionId, 'get_task_output', {
      task_id: taskId,
      cursor,
      byte_limit: 4,
    })
    const chunk = String(result.content)
    const nextCursor = Number(result.next_cursor)
    expect(Number(result.cursor)).toBe(cursor)
    expect(Number(result.bytes_read)).toBe(new TextEncoder().encode(chunk).byteLength)
    expect(chunk).not.toContain('\uFFFD')
    expect(nextCursor).toBeGreaterThanOrEqual(cursor)
    content += chunk
    if (Boolean(result.eof)) return content
    expect(nextCursor).toBeGreaterThan(cursor)
    cursor = nextCursor
  }
  throw new Error(`任务输出分页过多：${taskId}`)
}

beforeAll(async () => {
  await access(cliEntry)
  const root = await mkdtemp(join(tmpdir(), 'xcodes-native-task-controls-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(config, { recursive: true }),
  ])
  await Bun.write(
    join(config, 'settings.json'),
    JSON.stringify({ disableAutoMode: 'disable' }),
  )
  const git = Bun.spawnSync(['git', 'init', '--quiet'], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (git.exitCode !== 0) {
    throw new Error(`隔离 Git fixture 初始化失败：${git.stderr.toString()}`)
  }
  const fakeApi = startFakeAnthropicServer()
  const cli: CliLaunchSpec = {
    command: process.execPath,
    argv: [cliEntry, '--tools', 'Bash', 'Agent'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: 'fake-local-key',
      ANTHROPIC_BASE_URL: fakeApi.baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_TELEMETRY: '1',
      DISABLE_TELEMETRY: '1',
      NO_PROXY: '127.0.0.1,localhost',
      SHELL: '/bin/zsh',
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
    },
  }
  const service = startLocalService({
    token,
    stateDir: join(root, 'service-state'),
    defaultCli: cli,
  })
  fixture = { root, workspace, service, fakeApi }
}, 20_000)

afterAll(async () => {
  if (!fixture) return
  await fixture.service.shutdown()
  fixture.fakeApi.stop()
  await rm(fixture.root, { recursive: true, force: true })
})

describe('真实 CLI task controls', () => {
  test('两个 Bash 后台任务可快照、按 UTF-8 字节游标读取并只停止指定任务', async () => {
    const { sessionId } = await openSession()
    const runId = await send(sessionId, 'NATIVE_TASK_CONTROLS_BACKGROUND')

    const running = await eventually(
      () => control(sessionId, 'get_tasks'),
      result => taskSnapshots(result).filter(task => task.task_type === 'local_bash').length === 2,
    )
    expect(typeof running.captured_at).toBe('number')
    const tasks = taskSnapshots(running)
    const first = tasks.find(task => task.description.includes('任务甲'))
    const second = tasks.find(task => task.description.includes('任务乙'))
    if (!first || !second) throw new Error(`未找到两个真实 Bash 任务：${JSON.stringify(tasks)}`)
    expect(['pending', 'running']).toContain(second.status)

    const stopped = await control(sessionId, 'stop_task', { task_id: second.task_id })
    expect(stopped.stopped).toBe(true)
    const stopResult = stopped.result
    expect(stopResult !== undefined && isRecord(stopResult) ? stopResult.task_id : undefined)
      .toBe(second.task_id)
    await waitForCompleted(sessionId, runId)

    const settled = await eventually(
      () => control(sessionId, 'get_tasks'),
      result => {
        const current = taskSnapshots(result)
        return current.some(task => task.task_id === first.task_id && task.status === 'completed')
          && current.some(task => task.task_id === second.task_id && task.status === 'killed')
      },
    )
    const settledTasks = taskSnapshots(settled)
    expect(settledTasks.find(task => task.task_id === first.task_id)?.status).toBe('completed')
    expect(settledTasks.find(task => task.task_id === second.task_id)?.status).toBe('killed')

    const firstOutput = await readCompleteTaskOutput(sessionId, first.task_id)
    expect(firstOutput).toContain('任务甲🙂开始')
    expect(firstOutput).toContain('任务甲完成')
    const secondOutput = await readCompleteTaskOutput(sessionId, second.task_id)
    expect(secondOutput).toContain('任务乙🙂开始')
    expect(secondOutput).not.toContain('任务乙不应完成')
  }, 45_000)

  test('session transcript 分页快照冻结、顺序稳定，并在 --resume 后可重新读取', async () => {
    const opened = await openSession()
    const firstRun = await send(opened.sessionId, 'NATIVE_TASK_CONTROLS_TRANSCRIPT_ONE')
    await waitForCompleted(opened.sessionId, firstRun)

    const firstPage = transcriptPage(await control(
      opened.sessionId,
      'get_session_transcript',
      { cursor: 0, limit: 1 },
    ))
    expect(firstPage.snapshotId).not.toBe('')
    expect(firstPage.total).toBeGreaterThan(1)
    expect(firstPage.messages).toHaveLength(1)

    const secondRun = await send(opened.sessionId, 'NATIVE_TASK_CONTROLS_TRANSCRIPT_TWO')
    await waitForCompleted(opened.sessionId, secondRun)

    const frozenMessages = [...firstPage.messages]
    let frozenCursor = firstPage.nextCursor
    let frozenEof = firstPage.eof
    while (!frozenEof) {
      const page = transcriptPage(await control(
        opened.sessionId,
        'get_session_transcript',
        {
          snapshot_id: firstPage.snapshotId,
          cursor: frozenCursor,
          limit: 1,
        },
      ))
      expect(page.total).toBe(firstPage.total)
      expect(page.cursor).toBe(frozenCursor)
      frozenMessages.push(...page.messages)
      frozenCursor = page.nextCursor
      frozenEof = page.eof
    }
    expect(frozenMessages).toHaveLength(firstPage.total)
    expect(JSON.stringify(frozenMessages)).not.toContain('NATIVE_TASK_CONTROLS_TRANSCRIPT_TWO')

    const fresh = transcriptPage(await control(
      opened.sessionId,
      'get_session_transcript',
      { cursor: 0, limit: 1000 },
    ))
    expect(fresh.total).toBeGreaterThan(firstPage.total)
    const frozenIds = frozenMessages.map(message => String(message.uuid))
    const freshPrefixIds = fresh.messages
      .slice(0, frozenMessages.length)
      .map(message => String(message.uuid))
    expect(new Set(frozenIds).size).toBe(frozenIds.length)
    expect(freshPrefixIds).toEqual(frozenIds)

    expectSuccess(await rpc('session.close', { sessionId: opened.sessionId }))
    const resumed = await openSession({
      sessionId: opened.sessionId,
      resumeSessionId: opened.nativeSessionId,
    })
    const restored = transcriptPage(await control(
      resumed.sessionId,
      'get_session_transcript',
      { cursor: 0, limit: 1000 },
    ))
    expect(restored.total).toBeGreaterThanOrEqual(fresh.total)
    expect(restored.messages.map(message => String(message.uuid)).slice(0, fresh.total))
      .toEqual(fresh.messages.map(message => String(message.uuid)))
  }, 60_000)

  test('Agent 子代理任务、子 Bash 关系和 transcript 授权在 --resume 后保持', async () => {
    const opened = await openSession()
    const runId = await send(opened.sessionId, 'NATIVE_TASK_CONTROLS_AGENT_PARENT')
    await waitForCompleted(opened.sessionId, runId)

    const completed = await eventually(
      () => control(opened.sessionId, 'get_tasks'),
      result => {
        const tasks = taskSnapshots(result)
        const agent = tasks.find(task => task.task_type === 'local_agent')
        const child = tasks.find(task => task.task_type === 'local_bash')
        return agent?.status === 'completed'
          && agent.transcript_available
          && (child?.status === 'completed' || child?.status === 'killed')
      },
      45_000,
    )
    const tasks = taskSnapshots(completed)
    const agent = tasks.find(task => task.task_type === 'local_agent')
    const child = tasks.find(task => task.task_type === 'local_bash')
    if (!agent?.agent_id || !child) {
      throw new Error(`真实 Agent 任务快照不完整：${JSON.stringify(tasks)}`)
    }
    expect(child.parent_task_id).toBe(agent.task_id)

    const transcript = await control(opened.sessionId, 'get_subagent_transcript', {
      task_id: agent.task_id,
    })
    expect(transcript.task_id).toBe(agent.task_id)
    expect(transcript.agent_id).toBe(agent.agent_id)
    expect(Number(transcript.message_count)).toBeGreaterThan(0)
    expect(Array.isArray(transcript.messages)).toBe(true)
    const messages = Array.isArray(transcript.messages)
      ? transcript.messages.filter(isRecord)
      : []
    expect(messages.length).toBe(Number(transcript.message_count))
    expect(messages.some(message => message.type === 'user')).toBe(true)
    expect(messages.some(message => message.type === 'assistant')).toBe(true)
    expect(JSON.stringify(messages)).toContain('NATIVE_TASK_CONTROLS_AGENT_CHILD')
    expect(JSON.stringify(messages)).toContain('隔离回复 NATIVE_TASK_CONTROLS_AGENT_CHILD')

    const foreign = await openSession()
    await expect(control(foreign.sessionId, 'get_subagent_transcript', {
      task_id: agent.task_id,
    })).rejects.toThrow('No subagent task belongs to this session')

    expectSuccess(await rpc('session.close', { sessionId: opened.sessionId }))
    const resumed = await openSession({
      sessionId: opened.sessionId,
      resumeSessionId: opened.nativeSessionId,
    })
    const restored = await control(resumed.sessionId, 'get_subagent_transcript', {
      task_id: agent.task_id,
    })
    expect(restored.task_id).toBe(agent.task_id)
    expect(restored.agent_id).toBe(agent.agent_id)
    expect(restored.messages).toEqual(transcript.messages)
    expect(agent.child_task_ids).toContain(child.task_id)
  }, 60_000)
})
