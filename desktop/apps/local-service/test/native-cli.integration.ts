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
import { join } from 'node:path'
import { startLocalService, type LocalServiceHandle } from '../src/index.ts'
import { startFakeAnthropicServer, type FakeAnthropicServer } from './fixtures/fake-anthropic-server.ts'

const cliRoot = resolveNativeCliRoot()
const cliEntry = join(cliRoot, 'dist', 'cli-bun.js')
const token = 'native-cli-integration-token'
const question = 'Which isolated option should be used?'

interface IntegrationFixture {
  root: string
  workspace: string
  service: LocalServiceHandle
  fakeApi: FakeAnthropicServer
  cli: CliLaunchSpec
}

let fixture: IntegrationFixture

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

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

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待真实 CLI 状态超时：${JSON.stringify(value)}`)
    }
    await Bun.sleep(25)
    value = await read()
  }
  return value
}

async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  return fixture.service.manager.snapshot(sessionId)
}

async function snapshotFrom(
  service: LocalServiceHandle,
  sessionId: string,
): Promise<SessionSnapshot> {
  return service.manager.snapshot(sessionId)
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

async function openSession(permissionMode: PermissionMode = 'default'): Promise<string> {
  return openSessionOn(fixture.service, { permissionMode })
}

async function openSessionOn(
  service: LocalServiceHandle,
  params: {
    sessionId?: string
    nativeSessionId?: string
    resumeSessionId?: string
    resumeSessionAt?: string
    forkSession?: boolean
    permissionMode?: PermissionMode
  } = {},
): Promise<string> {
  const sessionId = params.sessionId ?? crypto.randomUUID()
  expectSuccess(
    await rpc(service, 'session.open', {
      sessionId,
      ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(params.resumeSessionAt ? { resumeSessionAt: params.resumeSessionAt } : {}),
      ...(params.forkSession !== undefined ? { forkSession: params.forkSession } : {}),
      cwd: fixture.workspace,
      permissionMode: params.permissionMode ?? 'default',
      model: 'claude-fake-local',
    }),
  )
  const initializeId = `initialize-${sessionId}`
  expectSuccess(
    await rpc(service, 'session.control', {
      sessionId,
      requestId: initializeId,
      subtype: 'initialize',
      payload: {},
    }),
  )
  await eventually(
    () => snapshotFrom(service, sessionId),
    value => controlResponse(value.events, initializeId)?.subtype === 'success',
  )
  return sessionId
}

async function control(
  service: LocalServiceHandle,
  sessionId: string,
  subtype: string,
  payload: Record<string, JsonValue> = {},
): Promise<Record<string, JsonValue>> {
  const requestId = `${subtype}-${crypto.randomUUID()}`
  expectSuccess(
    await rpc(service, 'session.control', {
      sessionId,
      requestId,
      subtype,
      payload,
    }),
  )
  const current = await eventually(
    () => snapshotFrom(service, sessionId),
    value => controlResponse(value.events, requestId) !== null,
  )
  const response = controlResponse(current.events, requestId)
  if (!response) throw new Error(`控制请求没有响应：${subtype}`)
  expect(response.subtype).toBe('success')
  const result = response.response
  if (result === undefined || !isRecord(result)) {
    throw new Error(`控制请求返回格式无效：${subtype}`)
  }
  return result
}

async function sendScenario(
  sessionId: string,
  scenario: string,
  targetPath: string,
): Promise<string> {
  const runId = crypto.randomUUID()
  expectSuccess(
    await rpc(fixture.service, 'session.send', {
      sessionId,
      requestId: `send-${runId}`,
      runId,
      content: `${scenario} TARGET_PATH=${targetPath}`,
    }),
  )
  return runId
}

async function sendText(
  service: LocalServiceHandle,
  sessionId: string,
  content: string,
): Promise<string> {
  const runId = crypto.randomUUID()
  expectSuccess(
    await rpc(service, 'session.send', {
      sessionId,
      requestId: `send-${runId}`,
      runId,
      content,
    }),
  )
  return runId
}

async function waitForPendingTool(
  sessionId: string,
  toolName: string,
): Promise<PendingControlSnapshot> {
  const current = await eventually(
    () => snapshot(sessionId),
    value =>
      value.pendingControls.some(pending => {
        const request = pending.request
        if (!isRecord(request)) return false
        return request.tool_name === toolName
      }),
  )
  const pending = current.pendingControls.find(candidate => {
    const request = candidate.request
    if (!isRecord(request)) return false
    return request.tool_name === toolName
  })
  if (!pending) throw new Error(`未找到 ${toolName} 审批请求`)
  return pending
}

async function allowPending(
  sessionId: string,
  pending: PendingControlSnapshot,
  updatedInput?: Record<string, JsonValue>,
): Promise<void> {
  const request = isRecord(pending.request) ? pending.request : {}
  const requestInput = request.input
  const originalInput = requestInput !== undefined && isRecord(requestInput) ? requestInput : {}
  expectSuccess(
    await rpc(fixture.service, 'session.respond', {
      sessionId,
      requestId: `respond-${crypto.randomUUID()}`,
      cliRequestId: pending.cliRequestId,
      response: {
        behavior: 'allow',
        updatedInput: updatedInput ?? originalInput,
      },
    }),
  )
}

async function denyPending(
  sessionId: string,
  pending: PendingControlSnapshot,
  message: string,
): Promise<void> {
  expectSuccess(
    await rpc(fixture.service, 'session.respond', {
      sessionId,
      requestId: `respond-${crypto.randomUUID()}`,
      cliRequestId: pending.cliRequestId,
      response: { behavior: 'deny', message },
    }),
  )
}

async function waitForCompleted(
  sessionId: string,
  runId: string,
  service = fixture.service,
): Promise<SessionSnapshot> {
  return eventually(
    () => snapshotFrom(service, sessionId),
    value =>
      value.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === runId &&
          isRecord(event.payload) &&
          event.payload.state === 'completed',
      ),
  )
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  await access(cliEntry)
  const root = await mkdtemp(join(tmpdir(), 'xcodes-native-cli-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const state = join(root, 'service-state')
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

  const fakeApi = startFakeAnthropicServer()
  const cli: CliLaunchSpec = {
    command: process.execPath,
    argv: [
      cliEntry,
      '--tools',
      'Bash',
      'Edit',
      'Read',
      'Write',
      'AskUserQuestion',
      'ExitPlanMode',
    ],
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
    stateDir: state,
    defaultCli: cli,
  })
  fixture = { root, workspace, service, fakeApi, cli }
}, 20_000)

afterAll(async () => {
  if (!fixture) return
  await fixture.service.shutdown()
  fixture.fakeApi.stop()
  await rm(fixture.root, { recursive: true, force: true })
})

describe('真实 CLI + 本机假 Anthropic 模型权限矩阵', () => {
  test('default：Write 通过 can_use_tool 审批后执行', async () => {
    const sessionId = await openSession('default')
    const target = join(fixture.workspace, `default-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, 'NATIVE_SCENARIO_DEFAULT_WRITE', target)
    const pending = await waitForPendingTool(sessionId, 'Write')
    expect(await fileExists(target)).toBe(false)
    await allowPending(sessionId, pending)
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await readFile(target, 'utf8')).toContain('NATIVE_SCENARIO_DEFAULT_WRITE')
  }, 30_000)

  test('acceptEdits：Write 自动执行，Bash 仍通过 can_use_tool 审批', async () => {
    const writeSessionId = await openSession('acceptEdits')
    const writeTarget = join(fixture.workspace, `accept-write-${writeSessionId}.txt`)
    const writeRun = await sendScenario(
      writeSessionId,
      'NATIVE_SCENARIO_ACCEPT_WRITE',
      writeTarget,
    )
    const writeSnapshot = await waitForCompleted(writeSessionId, writeRun)
    expect(writeSnapshot.pendingControls).toHaveLength(0)
    expect(await fileExists(writeTarget)).toBe(true)

    const bashSessionId = await openSession('acceptEdits')
    const bashTarget = join(fixture.workspace, `accept-bash-${bashSessionId}.txt`)
    const bashRun = await sendScenario(
      bashSessionId,
      'NATIVE_SCENARIO_ACCEPT_BASH',
      bashTarget,
    )
    const pending = await waitForPendingTool(bashSessionId, 'Bash')
    expect(await fileExists(bashTarget)).toBe(false)
    await allowPending(bashSessionId, pending)
    await waitForCompleted(bashSessionId, bashRun)
    expect(await readFile(bashTarget, 'utf8')).toBe('written')
  }, 45_000)

  test('bypassPermissions：Bash 不询问并直接执行', async () => {
    const sessionId = await openSession('bypassPermissions')
    const target = join(fixture.workspace, `bypass-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, 'NATIVE_SCENARIO_BYPASS', target)
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await readFile(target, 'utf8')).toBe('written')
  }, 30_000)

  test('dontAsk：未预批准 Write 被拒绝，且不会产生审批请求', async () => {
    const sessionId = await openSession('dontAsk')
    const target = join(fixture.workspace, `dont-ask-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, 'NATIVE_SCENARIO_DONT_ASK', target)
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await fileExists(target)).toBe(false)
  }, 30_000)

  test('plan：Bash 修改受计划模式限制且不会落盘', async () => {
    const sessionId = await openSession('plan')
    const target = join(fixture.workspace, `plan-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, 'NATIVE_SCENARIO_PLAN', target)
    const pending = await waitForPendingTool(sessionId, 'Bash')
    expect(await fileExists(target)).toBe(false)
    await denyPending(sessionId, pending, 'Plan mode only permits read-only work')
    const current = await waitForCompleted(sessionId, runId)
    expect(current.pendingControls).toHaveLength(0)
    expect(await fileExists(target)).toBe(false)
  }, 30_000)

  test('auto：分类器不可用时动态切换明确失败，不降级到其他权限模式', async () => {
    const sessionId = await openSession('default')
    const requestId = `auto-${crypto.randomUUID()}`
    expectSuccess(
      await rpc(fixture.service, 'session.control', {
        sessionId,
        requestId,
        subtype: 'set_permission_mode',
        payload: { mode: 'auto' },
      }),
    )
    const current = await eventually(
      () => snapshot(sessionId),
      value => controlResponse(value.events, requestId) !== null,
    )
    const response = controlResponse(current.events, requestId)
    expect(response?.subtype).toBe('error')
    expect(String(response?.error)).toContain('Cannot set permission mode to auto')
  }, 30_000)

  test('AskUserQuestion：结构化回答经 can_use_tool 回传后继续模型循环', async () => {
    const sessionId = await openSession('default')
    const target = join(fixture.workspace, `ask-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, 'NATIVE_SCENARIO_ASK_USER', target)
    const pending = await waitForPendingTool(sessionId, 'AskUserQuestion')
    const request = pending.request
    const input = isRecord(request) ? request.input : undefined
    if (input === undefined || !isRecord(input)) {
      throw new Error('AskUserQuestion 请求缺少结构化 input')
    }
    await allowPending(sessionId, pending, {
      ...input,
      answers: { [question]: 'Alpha' },
    })
    await waitForCompleted(sessionId, runId)
    expect(
      fixture.fakeApi.requests.some(
        request =>
          request.scenario === 'NATIVE_SCENARIO_ASK_USER' &&
          request.hasToolResult,
      ),
    ).toBe(true)
  }, 30_000)

  test('连续追问、上下文与手动压缩：每轮 usage 独立且产生真实 compact_boundary', async () => {
    const sessionId = await openSession('default')
    const runIds: string[] = []
    for (let turn = 1; turn <= 3; turn += 1) {
      const runId = await sendText(
        fixture.service,
        sessionId,
        `NATIVE_SCENARIO_USAGE turn=${turn}`,
      )
      runIds.push(runId)
      await waitForCompleted(sessionId, runId)
    }

    const beforeCompact = await snapshot(sessionId)
    const results = beforeCompact.events.filter(
      event =>
        event.kind === 'cli_message' &&
        runIds.includes(event.runId ?? '') &&
        isRecord(event.payload) &&
        event.payload.type === 'result',
    )
    expect(results).toHaveLength(3)
    for (const event of results) {
      const payload = isRecord(event.payload) ? event.payload : {}
      const usage = payload.usage !== undefined && isRecord(payload.usage)
        ? payload.usage
        : {}
      expect(usage.input_tokens).toBe(8)
      expect(usage.output_tokens).toBe(4)
    }

    const contextBefore = await control(
      fixture.service,
      sessionId,
      'get_context_usage',
    )
    expect(Number(contextBefore.totalTokens)).toBeGreaterThan(0)
    expect(Number(contextBefore.maxTokens)).toBeGreaterThan(0)
    expect(Array.isArray(contextBefore.categories)).toBe(true)
    expect(contextBefore.isAutoCompactEnabled).toBe(true)

    const compactRun = await sendText(
      fixture.service,
      sessionId,
      '/compact preserve the isolated usage fixture',
    )
    const compacted = await waitForCompleted(sessionId, compactRun)
    const boundary = compacted.events.find(
      event =>
        event.kind === 'cli_message' &&
        isRecord(event.payload) &&
        event.payload.type === 'system' &&
        event.payload.subtype === 'compact_boundary',
    )
    expect(boundary).toBeDefined()
    const boundaryPayload = boundary && isRecord(boundary.payload) ? boundary.payload : {}
    const metadata = boundaryPayload.compact_metadata !== undefined
      && isRecord(boundaryPayload.compact_metadata)
      ? boundaryPayload.compact_metadata
      : {}
    expect(metadata.trigger).toBe('manual')
    expect(Number(metadata.pre_tokens)).toBeGreaterThan(0)
    expect(Number(metadata.post_tokens)).toBeGreaterThan(0)
    expect(typeof metadata.summary).toBe('string')

    const contextAfter = await control(
      fixture.service,
      sessionId,
      'get_context_usage',
    )
    expect(Number(contextAfter.totalTokens)).toBeGreaterThan(0)
    expect(Number(contextAfter.maxTokens)).toBe(Number(contextBefore.maxTokens))
  }, 60_000)

  test('自动压缩：会话开关生效并在低阈值隔离进程产生 auto compact_boundary', async () => {
    const service = startLocalService({
      token,
      stateDir: join(fixture.root, `auto-compact-${crypto.randomUUID()}`),
      defaultCli: {
        ...fixture.cli,
        env: {
          ...(fixture.cli.env ?? {}),
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0.001',
        },
      },
    })
    try {
      const sessionId = await openSessionOn(service)
      const disabled = await control(service, sessionId, 'set_auto_compact', {
        enabled: false,
      })
      expect(disabled.enabled).toBe(false)
      expect(disabled.override).toBe(false)

      const seedRun = await sendText(
        service,
        sessionId,
        'NATIVE_SCENARIO_AUTO_COMPACT seed',
      )
      await waitForCompleted(sessionId, seedRun, service)

      const enabled = await control(service, sessionId, 'set_auto_compact', {
        enabled: true,
      })
      expect(enabled.enabled).toBe(true)
      expect(enabled.override).toBe(true)
      const triggerRun = await sendText(
        service,
        sessionId,
        'NATIVE_SCENARIO_AUTO_COMPACT trigger',
      )
      const current = await waitForCompleted(sessionId, triggerRun, service)
      const boundary = current.events.find(
        event =>
          event.kind === 'cli_message' &&
          isRecord(event.payload) &&
          event.payload.type === 'system' &&
          event.payload.subtype === 'compact_boundary' &&
          event.payload.compact_metadata !== undefined &&
          isRecord(event.payload.compact_metadata) &&
          event.payload.compact_metadata.trigger === 'auto',
      )
      expect(boundary).toBeDefined()

      const context = await control(service, sessionId, 'get_context_usage')
      expect(context.isAutoCompactEnabled).toBe(true)
      expect(Number(context.autoCompactThreshold)).toBeGreaterThan(0)
    } finally {
      await service.shutdown()
    }
  }, 60_000)

  test('原生历史：fork、rewind 与 clear 重启使用正确 native UUID', async () => {
    const desktopSessionId = `desktop-history-${crypto.randomUUID()}`
    const originalNativeId = crypto.randomUUID()
    await openSessionOn(fixture.service, {
      sessionId: desktopSessionId,
      nativeSessionId: originalNativeId,
    })
    const firstRun = await sendText(
      fixture.service,
      desktopSessionId,
      'NATIVE_SCENARIO_NATIVE_HISTORY first',
    )
    await waitForCompleted(desktopSessionId, firstRun)
    const secondRun = await sendText(
      fixture.service,
      desktopSessionId,
      'NATIVE_SCENARIO_NATIVE_HISTORY second',
    )
    const original = await waitForCompleted(desktopSessionId, secondRun)
    const firstUser = original.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === firstRun &&
        isRecord(event.payload) &&
        event.payload.type === 'user',
    )
    const firstUserUuid = firstUser && isRecord(firstUser.payload)
      ? firstUser.payload.uuid
      : undefined
    expect(typeof firstUserUuid).toBe('string')
    if (typeof firstUserUuid !== 'string') {
      throw new Error('原生历史缺少首条用户消息 UUID')
    }
    const originalResult = original.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === secondRun &&
        isRecord(event.payload) &&
        event.payload.type === 'result',
    )
    expect(
      originalResult && isRecord(originalResult.payload)
        ? originalResult.payload.session_id
        : undefined,
    ).toBe(originalNativeId)
    expectSuccess(
      await rpc(fixture.service, 'session.close', {
        sessionId: desktopSessionId,
      }),
    )

    const forkDesktopId = `desktop-fork-${crypto.randomUUID()}`
    const forkNativeId = crypto.randomUUID()
    await openSessionOn(fixture.service, {
      sessionId: forkDesktopId,
      nativeSessionId: forkNativeId,
      resumeSessionId: originalNativeId,
      resumeSessionAt: firstUserUuid,
      forkSession: true,
    })
    const forkRun = await sendText(
      fixture.service,
      forkDesktopId,
      'NATIVE_SCENARIO_NATIVE_HISTORY fork follow-up',
    )
    const forked = await waitForCompleted(forkDesktopId, forkRun)
    const forkResult = forked.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === forkRun &&
        isRecord(event.payload) &&
        event.payload.type === 'result',
    )
    expect(
      forkResult && isRecord(forkResult.payload)
        ? forkResult.payload.session_id
        : undefined,
    ).toBe(forkNativeId)
    expectSuccess(
      await rpc(fixture.service, 'session.close', { sessionId: forkDesktopId }),
    )

    await openSessionOn(fixture.service, {
      sessionId: desktopSessionId,
      resumeSessionId: originalNativeId,
      resumeSessionAt: firstUserUuid,
    })
    const rewindRun = await sendText(
      fixture.service,
      desktopSessionId,
      'NATIVE_SCENARIO_NATIVE_HISTORY rewind follow-up',
    )
    const rewound = await waitForCompleted(desktopSessionId, rewindRun)
    const rewindResult = rewound.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === rewindRun &&
        isRecord(event.payload) &&
        event.payload.type === 'result',
    )
    expect(
      rewindResult && isRecord(rewindResult.payload)
        ? rewindResult.payload.session_id
        : undefined,
    ).toBe(originalNativeId)
    expectSuccess(
      await rpc(fixture.service, 'session.close', {
        sessionId: desktopSessionId,
      }),
    )

    const clearedNativeId = crypto.randomUUID()
    await openSessionOn(fixture.service, {
      sessionId: desktopSessionId,
      nativeSessionId: clearedNativeId,
    })
    const clearRun = await sendText(
      fixture.service,
      desktopSessionId,
      'NATIVE_SCENARIO_NATIVE_HISTORY clear follow-up',
    )
    const cleared = await waitForCompleted(desktopSessionId, clearRun)
    const clearResult = cleared.events.find(
      event =>
        event.kind === 'cli_message' &&
        event.runId === clearRun &&
        isRecord(event.payload) &&
        event.payload.type === 'result',
    )
    expect(
      clearResult && isRecord(clearResult.payload)
        ? clearResult.payload.session_id
        : undefined,
    ).toBe(clearedNativeId)
    expect(clearedNativeId).not.toBe(originalNativeId)
  }, 90_000)

  test('后台 Bash：前台轮次完成后任务继续，并最终推送 task 状态', async () => {
    const sessionId = await openSession('bypassPermissions')
    const target = join(fixture.workspace, `background-${sessionId}.txt`)
    const runId = await sendScenario(
      sessionId,
      'NATIVE_SCENARIO_BACKGROUND',
      target,
    )
    await waitForCompleted(sessionId, runId)
    const current = await eventually(
      () => snapshot(sessionId),
      value => value.tasks.some(task => task.state === 'completed'),
    )
    expect(current.tasks.some(task => task.state === 'completed')).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('background')
  }, 30_000)

  test('退出：关闭服务后真实 CLI 与后台受管子进程均不遗留', async () => {
    const sessionId = await openSession('bypassPermissions')
    const pidFile = join(fixture.workspace, `shutdown-pids-${sessionId}.txt`)
    const runId = await sendScenario(
      sessionId,
      'NATIVE_SCENARIO_SHUTDOWN_BACKGROUND',
      pidFile,
    )
    await waitForCompleted(sessionId, runId)
    const running = await eventually(
      () => snapshot(sessionId),
      value => value.tasks.some(task => task.state === 'running'),
    )
    const cliPid = running.pid
    expect(cliPid).not.toBeNull()
    await eventually(
      () => fileExists(pidFile),
      exists => exists,
    )
    const childPids = (await readFile(pidFile, 'utf8'))
      .trim()
      .split(/\s+/)
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0)
    expect(childPids).toHaveLength(1)
    expect(childPids.every(processExists)).toBe(true)

    await fixture.service.shutdown()
    await eventually(
      () => [cliPid, ...childPids].filter((pid): pid is number => pid !== null),
      pids => pids.every(pid => !processExists(pid)),
      5_000,
    )
  }, 30_000)
})
