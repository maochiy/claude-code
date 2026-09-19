import { resolveNativeCliRoot } from './fixtures/native-cli-path.ts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type {
  CliLaunchSpec,
  DesktopEvent,
  JsonValue,
  PendingControlSnapshot,
  PermissionMode,
  RpcResponse,
  SessionSnapshot,
} from '@proma/desktop-protocol'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalService, type LocalServiceHandle } from '../src/index.ts'
import {
  startNativeInteractionsAnthropicServer,
  type NativeInteractionsAnthropicServer,
} from './fixtures/native-interactions-anthropic-server.ts'

const cliEntry = join(resolveNativeCliRoot(), 'dist', 'cli-bun.js')
const token = 'native-interactions-integration-token'
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const mcpFixture = join(fixtureDir, 'native-interactions-mcp-server.ts')
const mcpReadTool = 'mcp__native_interactions__read_value'
const mcpWriteTool = 'mcp__native_interactions__write_value'
const implementationQuestion = 'Which isolated implementation should be used?'
const checksQuestion = 'Which isolated checks should run?'

interface IntegrationFixture {
  root: string
  workspace: string
  tracePath: string
  service: LocalServiceHandle
  fakeApi: NativeInteractionsAnthropicServer
  cliEnv: Record<string, string>
}

interface McpTraceEntry {
  tool: 'read_value' | 'write_value'
  timestamp: number
}

let fixture: IntegrationFixture

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

async function rpcOn(
  service: LocalServiceHandle,
  method: string,
  params?: JsonValue,
): Promise<RpcResponse> {
  const response = await fetch(
    `http://${service.host}:${service.port}/v1/rpc`,
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

async function rpc(method: string, params?: JsonValue): Promise<RpcResponse> {
  return rpcOn(fixture.service, method, params)
}

function expectSuccess(response: RpcResponse): JsonValue {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待真实 CLI 交互超时：${JSON.stringify(value)}`)
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
      candidate.kind === 'control_resolved' &&
      candidate.requestId === requestId &&
      isRecord(candidate.payload) &&
      candidate.payload.direction === 'host_to_cli',
  )
  if (!event || !isRecord(event.payload)) return null
  const response = event.payload.response
  return response && isRecord(response) ? response : null
}

async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  return fixture.service.manager.snapshot(sessionId)
}

async function openSession(permissionMode: PermissionMode): Promise<string> {
  const sessionId = crypto.randomUUID()
  expectSuccess(
    await rpc('session.open', {
      sessionId,
      cwd: fixture.workspace,
      permissionMode,
      model: 'claude-native-interactions-fixture',
    }),
  )
  const initializeId = `initialize-${sessionId}`
  expectSuccess(
    await rpc('session.control', {
      sessionId,
      requestId: initializeId,
      subtype: 'initialize',
      payload: {},
    }),
  )
  const current = await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, initializeId) !== null,
  )
  const response = controlResponse(current.events, initializeId)
  expect(response?.subtype).toBe('success')
  return sessionId
}

function policyCli(policyJson: string): CliLaunchSpec {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      native_interactions: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpFixture],
        env: { NATIVE_INTERACTIONS_MCP_TRACE: fixture.tracePath },
      },
    },
  })
  return {
    command: process.execPath,
    argv: [
      cliEntry,
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--tools',
      'Read',
      'Bash',
    ],
    env: {
      ...fixture.cliEnv,
      XCODES_TOOL_POLICY_JSON: policyJson,
    },
  }
}

/** 每个策略场景使用独立 CLI 启动环境，避免进程或权限状态跨会话泄漏。 */
async function openPolicySession(policyJson: string): Promise<string> {
  const sessionId = crypto.randomUUID()
  const cli = policyCli(policyJson)
  expectSuccess(
    await rpc('session.open', {
      sessionId,
      cwd: fixture.workspace,
      permissionMode: 'bypassPermissions',
      model: 'claude-native-interactions-fixture',
      cli: {
        command: cli.command,
        argv: cli.argv,
        ...(cli.env ? { env: cli.env } : {}),
      },
    }),
  )
  const initializeId = `initialize-${sessionId}`
  expectSuccess(
    await rpc('session.control', {
      sessionId,
      requestId: initializeId,
      subtype: 'initialize',
      payload: {},
    }),
  )
  const current = await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, initializeId) !== null,
  )
  expect(controlResponse(current.events, initializeId)?.subtype).toBe('success')
  return sessionId
}

async function sendScenario(sessionId: string, content: string): Promise<string> {
  const runId = crypto.randomUUID()
  expectSuccess(
    await rpc('session.send', {
      sessionId,
      requestId: `send-${runId}`,
      runId,
      content,
    }),
  )
  return runId
}

function pendingTool(
  current: SessionSnapshot,
  toolName: string,
  afterCliRequestId?: string,
): PendingControlSnapshot | undefined {
  return current.pendingControls.find(candidate => {
    if (candidate.cliRequestId === afterCliRequestId) return false
    return isRecord(candidate.request) && candidate.request.tool_name === toolName
  })
}

async function waitForPendingTool(
  sessionId: string,
  toolName: string,
  afterCliRequestId?: string,
): Promise<PendingControlSnapshot> {
  const current = await eventually(
    () => snapshot(sessionId),
    value => pendingTool(value, toolName, afterCliRequestId) !== undefined,
  )
  const pending = pendingTool(current, toolName, afterCliRequestId)
  if (!pending) throw new Error(`未找到真实 ${toolName} 审批请求`)
  return pending
}

async function respond(
  sessionId: string,
  pending: PendingControlSnapshot,
  response: Record<string, JsonValue>,
): Promise<void> {
  expectSuccess(
    await rpc('session.respond', {
      sessionId,
      requestId: `respond-${crypto.randomUUID()}`,
      cliRequestId: pending.cliRequestId,
      response,
    }),
  )
}

async function allowPending(
  sessionId: string,
  pending: PendingControlSnapshot,
  updatedPermissions?: JsonValue[],
): Promise<void> {
  const requestInput = isRecord(pending.request) ? pending.request.input : undefined
  await respond(sessionId, pending, {
    behavior: 'allow',
    updatedInput: requestInput !== undefined && isRecord(requestInput) ? requestInput : {},
    ...(updatedPermissions ? { updatedPermissions } : {}),
  })
}

async function denyPending(
  sessionId: string,
  pending: PendingControlSnapshot,
  message: string,
): Promise<void> {
  await respond(sessionId, pending, { behavior: 'deny', message })
}

async function waitForCompleted(
  sessionId: string,
  runId: string,
): Promise<SessionSnapshot> {
  return eventually(
    () => snapshot(sessionId),
    value =>
      value.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === runId &&
          isRecord(event.payload) &&
          event.payload.state === 'completed',
      ),
    30_000,
  )
}

async function traceEntries(): Promise<McpTraceEntry[]> {
  const text = await readFile(fixture.tracePath, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as McpTraceEntry)
}

async function traceCount(tool: McpTraceEntry['tool']): Promise<number> {
  return (await traceEntries()).filter(entry => entry.tool === tool).length
}

async function runMcpScenario(
  permissionMode: PermissionMode,
  scenario: string,
): Promise<{ sessionId: string; runId: string }> {
  const sessionId = await openSession(permissionMode)
  const runId = await sendScenario(sessionId, scenario)
  return { sessionId, runId }
}

beforeAll(async () => {
  await Promise.all([access(cliEntry), access(mcpFixture)])
  const root = await mkdtemp(join(tmpdir(), 'xcodes-native-interactions-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const state = join(root, 'service-state')
  const tracePath = join(root, 'mcp-trace.jsonl')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(config, { recursive: true }),
  ])
  await Bun.write(join(config, 'settings.json'), JSON.stringify({ disableAutoMode: 'disable' }))
  const git = Bun.spawnSync(['git', 'init', '--quiet'], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (git.exitCode !== 0) {
    throw new Error(`隔离 Git fixture 初始化失败：${git.stderr.toString()}`)
  }

  const fakeApi = startNativeInteractionsAnthropicServer()
  const mcpConfig = JSON.stringify({
    mcpServers: {
      native_interactions: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpFixture],
        env: { NATIVE_INTERACTIONS_MCP_TRACE: tracePath },
      },
    },
  })
  const cliEnv = {
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
  }
  const cli: CliLaunchSpec = {
    command: process.execPath,
    argv: [
      cliEntry,
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--tools',
      'Write',
      'ExitPlanMode',
      'AskUserQuestion',
    ],
    env: cliEnv,
  }
  const service = startLocalService({ token, stateDir: state, defaultCli: cli })
  fixture = { root, workspace, tracePath, service, fakeApi, cliEnv }
}, 20_000)

afterAll(async () => {
  if (!fixture) return
  await fixture.service.shutdown()
  fixture.fakeApi.stop()
  await rm(fixture.root, { recursive: true, force: true })
})

describe('真实 CLI 的 ExitPlan 与 MCP 权限交互', () => {
  test("显式 --tools '' 与空 strict MCP 配置不会向模型暴露工具", async () => {
    const service = startLocalService({
      token,
      stateDir: join(fixture.root, `no-tools-state-${crypto.randomUUID()}`),
      defaultCli: {
        command: process.execPath,
        argv: [
          cliEntry,
          '--strict-mcp-config',
          '--mcp-config',
          JSON.stringify({ mcpServers: {} }),
          '--tools',
          '',
        ],
        env: fixture.cliEnv,
      },
    })
    try {
      const sessionId = crypto.randomUUID()
      expectSuccess(
        await rpcOn(service, 'session.open', {
          sessionId,
          cwd: fixture.workspace,
          permissionMode: 'default',
          model: 'claude-native-interactions-fixture',
        }),
      )
      const initializeId = `initialize-${sessionId}`
      expectSuccess(
        await rpcOn(service, 'session.control', {
          sessionId,
          requestId: initializeId,
          subtype: 'initialize',
          payload: {},
        }),
      )
      await eventually(
        () => service.manager.snapshot(sessionId),
        current => controlResponse(current.events, initializeId)?.subtype === 'success',
      )

      const runId = crypto.randomUUID()
      expectSuccess(
        await rpcOn(service, 'session.send', {
          sessionId,
          requestId: `send-${runId}`,
          runId,
          content: 'NATIVE_INTERACTION_NO_TOOLS',
        }),
      )
      await eventually(
        () => service.manager.snapshot(sessionId),
        current =>
          current.events.some(
            event =>
              event.kind === 'run_state' &&
              event.runId === runId &&
              isRecord(event.payload) &&
              event.payload.state === 'completed',
          ),
      )

      const apiRequest = fixture.fakeApi.requests.find(
        request => request.scenario === 'NATIVE_INTERACTION_NO_TOOLS',
      )
      expect(apiRequest).toBeDefined()
      if (!apiRequest || !isRecord(apiRequest.body)) {
        throw new Error('未收到无工具场景的真实 Anthropic 请求')
      }
      const tools = apiRequest.body.tools
      expect(tools === undefined || (Array.isArray(tools) && tools.length === 0)).toBe(true)
    } finally {
      await service.shutdown()
    }
  }, 30_000)

  test('ExitPlan：反馈后重新提出，批准为 acceptEdits 后进入执行循环', async () => {
    const sessionId = await openSession('plan')
    const target = join(fixture.workspace, `exit-plan-${sessionId}.txt`)
    const runId = await sendScenario(
      sessionId,
      `NATIVE_INTERACTION_EXIT_PLAN TARGET_PATH=${target}`,
    )

    const first = await waitForPendingTool(sessionId, 'ExitPlanMode')
    await denyPending(sessionId, first, 'Add explicit validation before implementation')

    const revised = await waitForPendingTool(
      sessionId,
      'ExitPlanMode',
      first.cliRequestId,
    )
    const revisedRequest = isRecord(revised.request) ? revised.request : {}
    expect(JSON.stringify(revisedRequest.input)).toContain('Revised isolated plan')
    expect(
      fixture.fakeApi.requests.some(
        request =>
          request.scenario === 'NATIVE_INTERACTION_EXIT_PLAN' &&
          request.ordinal === 2 &&
          JSON.stringify(request.body).includes('Add explicit validation'),
      ),
    ).toBe(true)

    await allowPending(sessionId, revised, [
      {
        type: 'setMode',
        mode: 'acceptEdits',
        destination: 'session',
      },
    ])

    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await readFile(target, 'utf8')).toBe('exit-plan-approved\n')
    expect(
      fixture.fakeApi.requests.some(
        request =>
          request.scenario === 'NATIVE_INTERACTION_EXIT_PLAN' &&
          request.ordinal === 4,
      ),
    ).toBe(true)
  }, 45_000)

  test('default：MCP 只读和写工具都支持真实拒绝与单次允许', async () => {
    const readBefore = await traceCount('read_value')
    const deniedRead = await runMcpScenario(
      'default',
      'NATIVE_INTERACTION_MCP_READ_DEFAULT_DENY',
    )
    const readPending = await waitForPendingTool(deniedRead.sessionId, mcpReadTool)
    expect(isRecord(readPending.request) && readPending.request.tool_name).toBe(mcpReadTool)
    await denyPending(deniedRead.sessionId, readPending, 'Reject isolated read fixture')
    await waitForCompleted(deniedRead.sessionId, deniedRead.runId)
    expect(await traceCount('read_value')).toBe(readBefore)

    const allowedRead = await runMcpScenario(
      'default',
      'NATIVE_INTERACTION_MCP_READ_DEFAULT_ALLOW',
    )
    await allowPending(
      allowedRead.sessionId,
      await waitForPendingTool(allowedRead.sessionId, mcpReadTool),
    )
    await waitForCompleted(allowedRead.sessionId, allowedRead.runId)
    expect(await traceCount('read_value')).toBe(readBefore + 1)

    const writeBefore = await traceCount('write_value')
    const deniedWrite = await runMcpScenario(
      'default',
      'NATIVE_INTERACTION_MCP_WRITE_DEFAULT_DENY',
    )
    await denyPending(
      deniedWrite.sessionId,
      await waitForPendingTool(deniedWrite.sessionId, mcpWriteTool),
      'Reject isolated write fixture',
    )
    await waitForCompleted(deniedWrite.sessionId, deniedWrite.runId)
    expect(await traceCount('write_value')).toBe(writeBefore)

    const allowedWrite = await runMcpScenario(
      'default',
      'NATIVE_INTERACTION_MCP_WRITE_DEFAULT_ALLOW',
    )
    await allowPending(
      allowedWrite.sessionId,
      await waitForPendingTool(allowedWrite.sessionId, mcpWriteTool),
    )
    await waitForCompleted(allowedWrite.sessionId, allowedWrite.runId)
    expect(await traceCount('write_value')).toBe(writeBefore + 1)
  }, 90_000)

  test('acceptEdits：MCP 写工具仍需审批，允许后才调用服务器', async () => {
    const before = await traceCount('write_value')
    const interaction = await runMcpScenario(
      'acceptEdits',
      'NATIVE_INTERACTION_MCP_WRITE_ACCEPT_EDITS',
    )
    const pending = await waitForPendingTool(interaction.sessionId, mcpWriteTool)
    expect(await traceCount('write_value')).toBe(before)
    await allowPending(interaction.sessionId, pending)
    await waitForCompleted(interaction.sessionId, interaction.runId)
    expect(await traceCount('write_value')).toBe(before + 1)
  }, 30_000)

  test('bypassPermissions：MCP 只读和写工具均无需 host 审批', async () => {
    const readBefore = await traceCount('read_value')
    const readInteraction = await runMcpScenario(
      'bypassPermissions',
      'NATIVE_INTERACTION_MCP_READ_BYPASS',
    )
    const readResult = await waitForCompleted(readInteraction.sessionId, readInteraction.runId)
    expect(readResult.pendingControls).toHaveLength(0)
    expect(await traceCount('read_value')).toBe(readBefore + 1)

    const writeBefore = await traceCount('write_value')
    const writeInteraction = await runMcpScenario(
      'bypassPermissions',
      'NATIVE_INTERACTION_MCP_WRITE_BYPASS',
    )
    const writeResult = await waitForCompleted(writeInteraction.sessionId, writeInteraction.runId)
    expect(writeResult.pendingControls).toHaveLength(0)
    expect(await traceCount('write_value')).toBe(writeBefore + 1)
  }, 45_000)

  test("宿主 allowedTools=['Read']：bypassPermissions 仍不能执行 Bash 或 MCP 写工具", async () => {
    const sessionId = await openPolicySession(JSON.stringify({ allowedTools: ['Read'] }))
    const writeBefore = await traceCount('write_value')
    const mcpRunId = await sendScenario(
      sessionId,
      'NATIVE_INTERACTION_MCP_WRITE_HOST_POLICY_READ_ONLY',
    )
    const mcpResult = await waitForCompleted(sessionId, mcpRunId)
    expect(mcpResult.pendingControls).toHaveLength(0)
    expect(await traceCount('write_value')).toBe(writeBefore)

    const targetDir = join(fixture.workspace, `host-policy-${sessionId}`)
    await mkdir(targetDir, { recursive: true })
    const bashRunId = await sendScenario(
      sessionId,
      `NATIVE_INTERACTION_UI_BACKGROUND_TASKS TARGET_PATH=${targetDir}`,
    )
    const bashResult = await waitForCompleted(sessionId, bashRunId)
    expect(bashResult.pendingControls).toHaveLength(0)
    await expect(access(join(targetDir, 'background-task-a.txt'))).rejects.toThrow()
    await expect(access(join(targetDir, 'background-task-b.txt'))).rejects.toThrow()
  }, 60_000)

  test('宿主空白名单：bypassPermissions 不能执行 MCP 写工具', async () => {
    const sessionId = await openPolicySession(JSON.stringify({ allowedTools: [] }))
    const before = await traceCount('write_value')
    const runId = await sendScenario(
      sessionId,
      'NATIVE_INTERACTION_MCP_WRITE_HOST_POLICY_EMPTY',
    )
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await traceCount('write_value')).toBe(before)
  }, 30_000)

  test('宿主策略 JSON 畸形：fail closed 且 bypassPermissions 不能执行 MCP 写工具', async () => {
    const sessionId = await openPolicySession('{malformed-json')
    const before = await traceCount('write_value')
    const runId = await sendScenario(
      sessionId,
      'NATIVE_INTERACTION_MCP_WRITE_HOST_POLICY_MALFORMED',
    )
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await traceCount('write_value')).toBe(before)
  }, 30_000)

  test('dontAsk：MCP 写工具自动拒绝且不触达服务器', async () => {
    const before = await traceCount('write_value')
    const interaction = await runMcpScenario(
      'dontAsk',
      'NATIVE_INTERACTION_MCP_WRITE_DONT_ASK',
    )
    const current = await waitForCompleted(interaction.sessionId, interaction.runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await traceCount('write_value')).toBe(before)
  }, 30_000)

  test('auto 门禁不可用时拒绝切换，MCP 写不会静默执行', async () => {
    const sessionId = await openSession('default')
    const requestId = `auto-${crypto.randomUUID()}`
    expectSuccess(
      await rpc('session.control', {
        sessionId,
        requestId,
        subtype: 'set_permission_mode',
        payload: { mode: 'auto' },
      }),
    )
    const controlled = await eventually(
      () => snapshot(sessionId),
      current => controlResponse(current.events, requestId) !== null,
    )
    const response = controlResponse(controlled.events, requestId)
    expect(response?.subtype).toBe('error')
    expect(String(response?.error)).toContain('Cannot set permission mode to auto')

    const before = await traceCount('write_value')
    const runId = await sendScenario(
      sessionId,
      'NATIVE_INTERACTION_MCP_WRITE_AUTO_UNAVAILABLE',
    )
    const pending = await waitForPendingTool(sessionId, mcpWriteTool)
    expect(await traceCount('write_value')).toBe(before)
    await denyPending(sessionId, pending, 'Auto mode is unavailable in this fixture')
    await waitForCompleted(sessionId, runId)
    expect(await traceCount('write_value')).toBe(before)
  }, 30_000)

  test('AskUserQuestion：多问题结构化回答完整返回模型循环', async () => {
    const sessionId = await openSession('default')
    const runId = await sendScenario(sessionId, 'NATIVE_INTERACTION_ASK_MULTI')
    const pending = await waitForPendingTool(sessionId, 'AskUserQuestion')
    const request = isRecord(pending.request) ? pending.request : {}
    const input = request.input
    if (input === undefined || !isRecord(input) || !Array.isArray(input.questions)) {
      throw new Error('AskUserQuestion 未提供结构化 questions')
    }
    expect(input.questions).toHaveLength(2)
    await respond(sessionId, pending, {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: {
          [implementationQuestion]: 'Alpha',
          [checksQuestion]: 'Types, Tests',
        },
      },
    })
    await waitForCompleted(sessionId, runId)

    const continuation = fixture.fakeApi.requests.find(
      candidate =>
        candidate.scenario === 'NATIVE_INTERACTION_ASK_MULTI' &&
        candidate.ordinal === 2,
    )
    expect(continuation).toBeDefined()
    const serialized = JSON.stringify(continuation?.body)
    expect(serialized).toContain('Alpha')
    expect(serialized).toContain('Types, Tests')
  }, 30_000)

  test('AskUserQuestion：取消会作为明确拒绝返回模型循环', async () => {
    const sessionId = await openSession('default')
    const runId = await sendScenario(sessionId, 'NATIVE_INTERACTION_ASK_CANCEL')
    const pending = await waitForPendingTool(sessionId, 'AskUserQuestion')
    await denyPending(sessionId, pending, 'User cancelled the structured questions')
    await waitForCompleted(sessionId, runId)

    const continuation = fixture.fakeApi.requests.find(
      candidate =>
        candidate.scenario === 'NATIVE_INTERACTION_ASK_CANCEL' &&
        candidate.ordinal === 2,
    )
    expect(continuation).toBeDefined()
    expect(JSON.stringify(continuation?.body)).toContain(
      'User cancelled the structured questions',
    )
  }, 30_000)

  test('plan：MCP 只读可经 host 允许，MCP 写工具可明确拒绝', async () => {
    const readBefore = await traceCount('read_value')
    const readInteraction = await runMcpScenario(
      'plan',
      'NATIVE_INTERACTION_MCP_READ_PLAN_ALLOW',
    )
    await allowPending(
      readInteraction.sessionId,
      await waitForPendingTool(readInteraction.sessionId, mcpReadTool),
    )
    await waitForCompleted(readInteraction.sessionId, readInteraction.runId)
    expect(await traceCount('read_value')).toBe(readBefore + 1)

    const writeBefore = await traceCount('write_value')
    const writeInteraction = await runMcpScenario(
      'plan',
      'NATIVE_INTERACTION_MCP_WRITE_PLAN_DENY',
    )
    await denyPending(
      writeInteraction.sessionId,
      await waitForPendingTool(writeInteraction.sessionId, mcpWriteTool),
      'Plan mode rejects isolated mutation',
    )
    await waitForCompleted(writeInteraction.sessionId, writeInteraction.runId)
    expect(await traceCount('write_value')).toBe(writeBefore)
  }, 45_000)
})
