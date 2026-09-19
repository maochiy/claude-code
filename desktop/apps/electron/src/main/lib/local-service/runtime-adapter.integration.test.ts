import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { SDKMessage, SDKUserMessageInput } from '@proma/shared'
import type { LocalServiceEvent } from './client'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { builtinMcpToolFactory } from '../builtin-mcp/tool-definition'
import { createLazyBuiltinMcpServerDefinition } from '../builtin-mcp/lazy-definition'
import { promaBuiltinMcpHttpHost } from '../builtin-mcp/http-host'
import type { LocalCliAgentQueryOptions } from './query-options'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
    getPath: (): string => tmpdir(),
  },
  BrowserWindow: { getFocusedWindow: () => null },
  clipboard: {},
  dialog: {},
  nativeTheme: {},
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
  },
  shell: {},
}))

const fakeCli = join(import.meta.dir, 'test-fixtures', 'runtime-adapter-fake-cli.ts')
const serviceEntry = join(import.meta.dir, '../../../../../local-service/src/index.ts')
const token = 'runtime-adapter-integration-token'

let LocalCliRuntimeAdapter: typeof import('./runtime-adapter').LocalCliRuntimeAdapter
let LocalServiceClient: typeof import('./client').LocalServiceClient
let localServiceSupervisor: typeof import('./supervisor').localServiceSupervisor

beforeAll(async () => {
  ;({ LocalCliRuntimeAdapter } = await import('./runtime-adapter'))
  ;({ LocalServiceClient } = await import('./client'))
  ;({ localServiceSupervisor } = await import('./supervisor'))
})

interface TestLocalServiceHandle {
  host: '127.0.0.1'
  port: number
  shutdown: () => Promise<void>
}

interface TraceEntry {
  kind?: string
  argv?: string[]
  text?: string
  request?: Record<string, unknown>
  response?: Record<string, unknown>
}

interface IntegrationContext {
  root: string
  workspace: string
  skills: string
  tracePath: string
  service: TestLocalServiceHandle
  client: InstanceType<typeof LocalServiceClient>
  adapter: InstanceType<typeof LocalCliRuntimeAdapter>
  sessionIds: Set<string>
  setClient: (client: InstanceType<typeof LocalServiceClient>) => void
  restoreSupervisor: () => void
}

let context: IntegrationContext | undefined
let previousDataRoot: string | undefined

async function startTestLocalService(stateDir: string): Promise<TestLocalServiceHandle> {
  const child = Bun.spawn([process.execPath, 'run', serviceEntry], {
    cwd: join(import.meta.dir, '../../../../../..'),
    env: {
      ...process.env,
      XCODES_LOCAL_SERVICE_TOKEN: token,
      XCODES_LOCAL_SERVICE_STATE_DIR: stateDir,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let ready: { type?: string; port?: number } | undefined
  try {
    while (!ready) {
      const { done, value } = await reader.read()
      if (done) throw new Error('Local Service 在 ready 前退出')
      buffered += decoder.decode(value, { stream: true })
      const newline = buffered.indexOf('\n')
      if (newline < 0) continue
      const parsed = JSON.parse(buffered.slice(0, newline)) as { type?: string; port?: number }
      if (parsed.type === 'local_service_ready' && parsed.port) ready = parsed
      buffered = buffered.slice(newline + 1)
    }
  } finally {
    reader.releaseLock()
  }

  const port = ready.port!
  return {
    host: '127.0.0.1',
    port,
    shutdown: async () => {
      if (child.exitCode !== null) return
      await fetch(`http://127.0.0.1:${port}/v1/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          method: 'service.shutdown',
          params: {},
        }),
      }).catch(() => undefined)
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ])
      if (!exited && child.exitCode === null) {
        child.kill()
        await child.exited
      }
    },
  }
}

async function setupIntegration(): Promise<IntegrationContext> {
  const root = await mkdtemp(join(tmpdir(), 'proma-runtime-adapter-'))
  const workspace = join(root, 'workspace')
  const skills = join(root, 'skills')
  const config = join(root, 'config')
  const home = join(root, 'home')
  const tracePath = join(root, 'cli-trace.jsonl')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(skills, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(home, { recursive: true }),
  ])
  previousDataRoot = process.env.XCODES_DATA_ROOT
  process.env.XCODES_DATA_ROOT = config

  const service = await startTestLocalService(join(root, 'service-state'))
  const client = new LocalServiceClient(
    `http://${service.host}:${service.port}`,
    token,
  )
  await client.connect()

  const originalGetClient = localServiceSupervisor.getClient
  const originalGetCliCommand = localServiceSupervisor.getCliCommand
  const originalDispose = localServiceSupervisor.dispose
  let activeClient = client
  localServiceSupervisor.getClient = async () => activeClient
  localServiceSupervisor.getCliCommand = () => ({
    command: process.execPath,
    argv: ['run', fakeCli],
  })
  localServiceSupervisor.dispose = async () => {}

  return {
    root,
    workspace,
    skills,
    tracePath,
    service,
    client,
    adapter: new LocalCliRuntimeAdapter(),
    sessionIds: new Set<string>(),
    setClient: nextClient => { activeClient = nextClient },
    restoreSupervisor: () => {
      localServiceSupervisor.getClient = originalGetClient
      localServiceSupervisor.getCliCommand = originalGetCliCommand
      localServiceSupervisor.dispose = originalDispose
    },
  }
}

beforeEach(async () => {
  context = await setupIntegration()
})

afterEach(async () => {
  const current = context
  context = undefined
  if (!current) return
  await Promise.allSettled(
    [...current.sessionIds].map(sessionId => current.adapter.closeSession(sessionId)),
  )
  current.client.dispose()
  await current.service.shutdown()
  current.restoreSupervisor()
  await promaBuiltinMcpHttpHost.shutdown()
  await rm(current.root, { recursive: true, force: true })
  if (previousDataRoot === undefined) delete process.env.XCODES_DATA_ROOT
  else process.env.XCODES_DATA_ROOT = previousDataRoot
})

function createQueryInput(
  current: IntegrationContext,
  sessionId: string,
  prompt: string,
  overrides: Partial<LocalCliAgentQueryOptions> = {},
): LocalCliAgentQueryOptions {
  current.sessionIds.add(sessionId)
  return {
    sessionId,
    prompt,
    cwd: current.workspace,
    sdkPermissionMode: 'default',
    additionalSkillDirectories: [current.skills],
    env: {
      PATH: process.env.PATH,
      HOME: join(current.root, 'home'),
      CLAUDE_CONFIG_DIR: join(current.root, 'config'),
      FAKE_CLI_TRACE_PATH: current.tracePath,
    },
    ...overrides,
  }
}

async function collect(
  adapter: InstanceType<typeof LocalCliRuntimeAdapter>,
  input: LocalCliAgentQueryOptions,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  for await (const message of adapter.query(input)) messages.push(message)
  return messages
}

function readAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  const content = (message.message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    const text = (block as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

function readResultText(message: SDKMessage): string {
  if (message.type !== 'result') return ''
  const result = (message as Record<string, unknown>).result
  return typeof result === 'string' ? result : ''
}

async function readTrace(current: IntegrationContext): Promise<TraceEntry[]> {
  const text = await Bun.file(current.tracePath).text().catch(() => '')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceEntry)
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

async function restartTransport(current: IntegrationContext): Promise<void> {
  const service = await startTestLocalService(
    join(current.root, `service-state-${crypto.randomUUID()}`),
  )
  const client = new LocalServiceClient(
    `http://${service.host}:${service.port}`,
    token,
  )
  await client.connect()
  current.service = service
  current.client = client
  current.setClient(client)
}

describe('LocalCliRuntimeAdapter loopback 集成', () => {
  test('Given Agent 惰性内置工具 When 经服务启动 CLI Then 子进程配置可被 MCP 客户端调用且关闭后失效', async () => {
    const current = context!
    const sessionId = 'builtin-mcp-session'
    let calls = 0
    const definition = createLazyBuiltinMcpServerDefinition({
      name: 'fixture-browser', description: '隔离浏览器工具',
      load: async () => builtinMcpToolFactory.createSdkMcpServer({
        name: 'fixture-browser', version: '1',
        tools: [builtinMcpToolFactory.tool('read_fixture', '只读 fixture', {}, async () => {
          calls++
          return { content: [{ type: 'text', text: 'fixture result' }] }
        })],
      }),
    })
    await collect(current.adapter, createQueryInput(current, sessionId, 'hello', { mcpServers: { browser: definition } }))
    const argv = (await readTrace(current)).find(entry => entry.kind === 'startup')?.argv ?? []
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!) as {
      mcpServers: { browser: { type: string; url: string; headers: Record<string, string> } }
    }
    const endpoint = config.mcpServers.browser
    expect(endpoint.type).toBe('http')
    const mcp = new Client({ name: 'isolated-fixture-client', version: '1' })
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }))
      expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(['read_fixture'])
      expect((await mcp.callTool({ name: 'read_fixture', arguments: {} })).content).toEqual([{ type: 'text', text: 'fixture result' }])
      expect(calls).toBe(1)
    } finally {
      await mcp.close()
      await current.adapter.closeSession(sessionId)
    }
    expect((await fetch(endpoint.url, { headers: endpoint.headers })).status).toBe(404)
  })

  test('Given Chat 禁用内置工具 When 启动 CLI Then 空工具范围和独立 MCP 配置保留到子进程', async () => {
    const current = context!
    await collect(current.adapter, createQueryInput(current, 'restricted-tools', 'hello', {
      availableBuiltinTools: [],
      strictMcpConfig: true,
      mcpServers: {},
    }))
    const argv = (await readTrace(current)).find(entry => entry.kind === 'startup')?.argv ?? []
    expect(argv).toContain('--tools')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: {} })
  })

  test('Given 首页命令目录仍在读取 When 首条消息需要完整执行配置 Then 等待预热控制后只发送一次', async () => {
    const current = context!
    const sessionId = 'home-first-send-race'
    const input = createQueryInput(current, sessionId, 'home first send', {
      channelId: 'home-channel',
      systemPrompt: '完整执行提示词',
      env: {
        PATH: process.env.PATH,
        HOME: join(current.root, 'home'),
        CLAUDE_CONFIG_DIR: join(current.root, 'config'),
        FAKE_CLI_TRACE_PATH: current.tracePath,
        FAKE_CLI_DELAY_CONTROL_SUBTYPE: 'set_skill_directories',
        FAKE_CLI_DELAY_CONTROL_MS: '150',
      },
    })
    await current.adapter.prepareSession({
      sessionId,
      runtimeSessionId: '',
      cwd: current.workspace,
      model: input.model,
      env: input.env,
      permissionMode: 'default',
      additionalSkillDirectories: input.additionalSkillDirectories,
      channelId: input.channelId,
    })

    const catalogPromise = current.adapter.getCommandCatalog(sessionId)
    await eventually(async () => (await readTrace(current)).some(entry =>
      entry.kind === 'control_request' && entry.request?.subtype === 'set_skill_directories'))
    const messagesPromise = collect(current.adapter, input)

    const [catalog, messages] = await Promise.all([catalogPromise, messagesPromise])
    expect(catalog.commands).toContainEqual({
      name: 'skill-fixture',
      description: 'Workspace skill',
      argumentHint: '',
    })
    expect(messages.map(readResultText)).toContain('回复：home first send')

    const trace = await readTrace(current)
    expect(trace.filter(entry => entry.kind === 'startup')).toHaveLength(2)
    expect(trace.filter(entry => entry.kind === 'user').map(entry => entry.text)).toEqual([
      'home first send',
    ])
  })

  test('Given 首页命令、上下文和任务快照并发预热 When 首条消息切换完整配置 Then 等待只读控制后执行', async () => {
    const current = context!
    const sessionId = 'home-first-send-native-preheat'
    const input = createQueryInput(current, sessionId, 'native preheat first send', {
      channelId: 'home-channel',
      systemPrompt: '完整执行提示词',
      env: {
        PATH: process.env.PATH,
        HOME: join(current.root, 'home'),
        CLAUDE_CONFIG_DIR: join(current.root, 'config'),
        FAKE_CLI_TRACE_PATH: current.tracePath,
        FAKE_CLI_CONCURRENT_CONTROLS: '1',
        FAKE_CLI_DELAY_CONTROL_SUBTYPE: 'get_tasks',
        FAKE_CLI_DELAY_CONTROL_MS: '150',
      },
    })
    await current.adapter.prepareSession({
      sessionId,
      runtimeSessionId: '',
      cwd: current.workspace,
      model: input.model,
      env: input.env,
      permissionMode: 'default',
      additionalSkillDirectories: input.additionalSkillDirectories,
      channelId: input.channelId,
    })

    const catalogPromise = current.adapter.getCommandCatalog(sessionId)
    const contextPromise = current.adapter.getContextUsage(sessionId)
    const firstTasksPromise = current.adapter.getExecutionGraph(sessionId)
    const secondTasksPromise = current.adapter.getExecutionGraph(sessionId)
    await eventually(async () => (await readTrace(current)).filter(entry =>
      entry.kind === 'control_request' && entry.request?.subtype === 'get_tasks').length === 2)
    const messagesPromise = collect(current.adapter, input)

    const [catalog, contextUsage, firstTasks, secondTasks, messages] = await Promise.all([
      catalogPromise,
      contextPromise,
      firstTasksPromise,
      secondTasksPromise,
      messagesPromise,
    ])
    expect(catalog.commands).toContainEqual({
      name: 'skill-fixture',
      description: 'Workspace skill',
      argumentHint: '',
    })
    expect(contextUsage.applied).toBe(true)
    expect(firstTasks.nodes).toEqual([])
    expect(secondTasks.nodes).toEqual([])
    expect(messages.map(readResultText)).toContain('回复：native preheat first send')

    const trace = await readTrace(current)
    const controls = trace
      .filter(entry => entry.kind === 'control_request')
      .map(entry => entry.request?.subtype)
    expect(controls).toContain('set_skill_directories')
    expect(controls).toContain('get_context_usage')
    expect(controls.filter(subtype => subtype === 'get_tasks')).toHaveLength(2)
    expect(trace.filter(entry => entry.kind === 'startup')).toHaveLength(2)
    expect(trace.filter(entry => entry.kind === 'user').map(entry => entry.text)).toEqual([
      'native preheat first send',
    ])
  })

  test('Given 非预热控制请求仍在处理 When 执行配置改变 Then 保持安全门禁且不发送消息', async () => {
    const current = context!
    const sessionId = 'unsafe-control-config-switch'
    const baseInput = createQueryInput(current, sessionId, 'must not send', {
      channelId: 'same-channel',
      env: {
        PATH: process.env.PATH,
        HOME: join(current.root, 'home'),
        CLAUDE_CONFIG_DIR: join(current.root, 'config'),
        FAKE_CLI_TRACE_PATH: current.tracePath,
        FAKE_CLI_DELAY_CONTROL_SUBTYPE: 'set_permission_mode',
        FAKE_CLI_DELAY_CONTROL_MS: '150',
      },
    })
    await current.adapter.prepareSession({
      sessionId,
      runtimeSessionId: '',
      cwd: current.workspace,
      env: baseInput.env,
      permissionMode: 'default',
      additionalSkillDirectories: baseInput.additionalSkillDirectories,
      channelId: baseInput.channelId,
    })

    const permissionChange = current.adapter.setPermissionMode(sessionId, 'plan')
    await eventually(async () => (await readTrace(current)).some(entry =>
      entry.kind === 'control_request' && entry.request?.subtype === 'set_permission_mode'))
    await expect(collect(current.adapter, {
      ...baseInput,
      systemPrompt: '触发执行指纹变化',
    })).rejects.toThrow('执行或控制请求处理中，不能切换目录或渠道')
    await permissionChange

    expect((await readTrace(current)).filter(entry => entry.kind === 'user')).toHaveLength(0)
  })

  test('Given 工作区 Skills 和半包 CLI When 连续执行两轮 Then initialize 生效、实时增量且不重发旧输入', async () => {
    const current = context!
    const sessionId = 'adapter-stream-session'

    const first = await collect(current.adapter, createQueryInput(
      current,
      sessionId,
      'stream partial first',
    ))
    const catalog = await current.adapter.getCommandCatalog(sessionId)
    const second = await collect(current.adapter, createQueryInput(
      current,
      sessionId,
      'second round',
    ))
    const partialTexts = first
      .filter(message => message.type === 'assistant'
        && (message as Record<string, unknown>)._partial === true)
      .map(readAssistantText)
    expect(partialTexts).toContain('实时')
    expect(partialTexts).toContain('实时增量')
    expect(first.map(readResultText)).toContain('实时增量：stream partial first')
    expect(second.map(readResultText)).toContain('回复：second round')
    expect(second.map(readResultText).join('\n')).not.toContain('stream partial first')
    expect(catalog.commands).toContainEqual({
      name: 'skill-fixture',
      description: 'Workspace skill',
      argumentHint: '',
    })

    const trace = await readTrace(current)
    const initialize = trace.find(entry =>
      entry.kind === 'control_request' && entry.request?.subtype === 'initialize')
    expect(initialize?.request?.additionalSkillDirectories).toEqual([current.skills])
    expect(trace.filter(entry => entry.kind === 'user').map(entry => entry.text)).toEqual([
      'stream partial first',
      'second round',
    ])
  })

  test('Given CLI 权限请求或取消 When Adapter 响应 Then 批准完成且取消信号终止等待', async () => {
    const current = context!
    let approvalCalls = 0
    const approved = await collect(current.adapter, createQueryInput(
      current,
      'adapter-permission-session',
      'permission',
      {
        canUseTool: async (_toolName, input) => {
          approvalCalls += 1
          return { behavior: 'allow', updatedInput: input }
        },
      },
    ))
    expect(approvalCalls).toBe(1)
    expect(approved.map(readResultText)).toContain('permission accepted')

    let cancelled = false
    const cancelledRun = await collect(current.adapter, createQueryInput(
      current,
      'adapter-cancel-session',
      'cancel control',
      {
        canUseTool: async (_toolName, _input, options) => new Promise((resolve) => {
          const finish = (): void => {
            cancelled = true
            resolve({ behavior: 'deny', message: 'cancelled' })
          }
          if (options.signal.aborted) finish()
          else options.signal.addEventListener('abort', finish, { once: true })
        }),
      },
    ))
    expect(cancelled).toBe(true)
    expect(cancelledRun.some(message => message.type === 'result')).toBe(true)

    const responses = (await readTrace(current))
      .filter(entry => entry.kind === 'control_response')
    expect(responses).toHaveLength(1)
    expect(responses[0]?.response).toMatchObject({
      response: { behavior: 'allow' },
    })
  })

  test('Given 前台轮次挂起且消息入队 When 中断当前轮次 Then 队列只消费一次并在后台完成', async () => {
    const current = context!
    const sessionId = 'adapter-queue-session'
    const backgroundMessages: SDKMessage[] = []
    current.adapter.onBackgroundMessage = (_id, message) => backgroundMessages.push(message)

    const hanging = collect(
      current.adapter,
      createQueryInput(current, sessionId, 'hang'),
    )
    await eventually(async () => (await readTrace(current))
      .some(entry => entry.kind === 'user' && entry.text === 'hang'))

    let accepted = false
    let queueStarted = false
    const queuedMessage: SDKUserMessageInput = {
      type: 'user',
      message: { role: 'user', content: 'queued next' },
      rawText: 'queued next',
      parent_tool_use_id: null,
      uuid: 'queued-message-uuid',
      session_id: sessionId,
      priority: 'next',
    }
    const queued = current.adapter.sendQueuedMessage(sessionId, queuedMessage, {
      onAccepted: () => { accepted = true },
    }).then(() => { queueStarted = true })
    await eventually(() => accepted)
    await Bun.sleep(25)
    expect(queueStarted).toBe(false)

    await current.adapter.abort(sessionId)
    await Promise.all([hanging, queued])
    await eventually(() => backgroundMessages
      .map(readResultText)
      .includes('回复：queued next'))

    const sent = (await readTrace(current))
      .filter(entry => entry.kind === 'user')
      .map(entry => entry.text)
    expect(sent).toEqual(['hang', 'queued next'])
  })

  test('Given 断线日志出现缺口 When 收到权威快照 Then 取消旧轮次、保留后台任务且下一轮不重发', async () => {
    const current = context!
    const sessionId = 'adapter-replay-reset-session'
    let restored: SDKMessage[] = []
    const hanging = collect(
      current.adapter,
      createQueryInput(current, sessionId, 'hang before replay reset', { onNativeHistory: messages => { restored = messages } }),
    )
    await eventually(async () => (await readTrace(current))
      .some(entry => entry.kind === 'user' && entry.text === 'hang before replay reset'))

    let queuedAccepted = false
    const queued = current.adapter.sendQueuedMessage(sessionId, {
      type: 'user',
      message: { role: 'user', content: 'must not replay after reset' },
      rawText: 'must not replay after reset',
      parent_tool_use_id: null,
      uuid: 'replay-reset-queued-message',
      session_id: sessionId,
      priority: 'next',
    }, {
      onAccepted: () => { queuedAccepted = true },
    })
    const queuedOutcome = queued.then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    )
    await eventually(() => queuedAccepted)

    interface ReplayInjectableAdapter {
      sessions: Map<string, unknown>
      receive: (client: InstanceType<typeof LocalServiceClient>, session: unknown, event: LocalServiceEvent) => void
    }
    const internals = current.adapter as unknown as ReplayInjectableAdapter
    const runtimeSession = internals.sessions.get(sessionId)
    expect(runtimeSession).toBeDefined()
    internals.receive(current.client, runtimeSession, {
      type: 'desktop_event',
      protocolVersion: 1,
      eventId: 'forced-replay-reset',
      sessionId,
      generation: 1,
      seq: 50_000,
      timestamp: Date.now(),
      source: 'service',
      kind: 'replay_reset',
      payload: {
        activeRunId: undefined,
        pendingControls: [],
        tasks: [{ taskId: 'background-live', state: 'running', updatedAt: Date.now() }],
      },
    })

    await expect(hanging).rejects.toThrow('当前前台轮次已安全停止')
    expect((await queuedOutcome)?.message).toMatch(/队列消息已取消|事件日志/)
    expect(current.adapter.hasSession(sessionId)).toBe(true)
    expect(current.adapter.canStopTask(sessionId, 'background-live')).toBe(true)
    expect(restored.map(message => (message as Record<string, unknown>).uuid)).toEqual(['native-gap-message'])

    const recovered = await collect(
      current.adapter,
      createQueryInput(current, sessionId, 'after replay reset'),
    )
    expect(recovered.map(readResultText)).toContain('回复：after replay reset')
    expect((await readTrace(current))
      .filter(entry => entry.kind === 'user')
      .map(entry => entry.text)).toEqual([
        'hang before replay reset',
        'after replay reset',
      ])
  })

  test('Given Local Service 退出 When 下次请求重新取得传输 Then 旧 Session 失效且同会话可恢复执行', async () => {
    const current = context!
    const sessionId = 'adapter-service-restart-session'
    const first = await collect(
      current.adapter,
      createQueryInput(current, sessionId, 'before service exit'),
    )
    expect(first.map(readResultText)).toContain('回复：before service exit')
    expect(current.adapter.hasSession(sessionId)).toBe(true)

    current.client.dispose(new Error('simulated Local Service exit'))
    await current.service.shutdown()
    await eventually(() => !current.adapter.hasSession(sessionId))
    await restartTransport(current)

    const recovered = await collect(
      current.adapter,
      createQueryInput(current, sessionId, 'after service restart'),
    )
    expect(recovered.map(readResultText)).toContain('回复：after service restart')
    expect(current.adapter.hasSession(sessionId)).toBe(true)
    expect((await readTrace(current))
      .filter(entry => entry.kind === 'user')
      .map(entry => entry.text)).toEqual([
        'before service exit',
        'after service restart',
      ])
  })
})
