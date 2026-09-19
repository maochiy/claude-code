import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type {
  CliLaunchSpec,
  DesktopEvent,
  JsonValue,
  PendingControlSnapshot,
  RpcResponse,
  SessionSnapshot,
} from '@proma/desktop-protocol'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalService, type LocalServiceHandle } from '../src/index.ts'
import {
  startAutoClassifierFakeServer,
  type AutoClassifierFakeServer,
  type AutoClassifierScenario,
} from './fixtures/native-auto-classifier-anthropic-server.ts'
import { resolveNativeCliRoot } from './fixtures/native-cli-path.ts'

const cliEntry = join(resolveNativeCliRoot(), 'dist', 'cli-bun.js')
const token = 'native-auto-classifier-token'

interface AutoFixture {
  root: string
  workspace: string
  service: LocalServiceHandle
  fakeApi: AutoClassifierFakeServer
}

let fixture: AutoFixture

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
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
      throw new Error(`等待 Auto classifier 状态超时：${JSON.stringify(value)}`)
    }
    await Bun.sleep(25)
    value = await read()
  }
  return value
}

async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  return fixture.service.manager.snapshot(sessionId)
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
  return isRecord(response) ? response : null
}

function classifierStatuses(
  current: SessionSnapshot,
  scenario: AutoClassifierScenario,
): string[] {
  return current.events.flatMap(event => {
    if (event.kind !== 'cli_message' || !isRecord(event.payload)) return []
    if (
      event.payload.type !== 'system' ||
      event.payload.subtype !== 'auto_mode_classifier'
    ) {
      return []
    }
    const requestForScenario = fixture.fakeApi.requests.some(
      request => request.scenario === scenario && request.kind === 'classifier',
    )
    return requestForScenario && typeof event.payload.status === 'string'
      ? [event.payload.status]
      : []
  })
}

function requestKinds(scenario: AutoClassifierScenario): string[] {
  return fixture.fakeApi.requests
    .filter(request => request.scenario === scenario)
    .map(request => request.kind)
}

async function openAutoSession(): Promise<string> {
  const sessionId = crypto.randomUUID()
  expectSuccess(
    await rpc('session.open', {
      sessionId,
      nativeSessionId: crypto.randomUUID(),
      cwd: fixture.workspace,
      permissionMode: 'default',
      model: 'claude-fake-local',
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
  await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, initializeId)?.subtype === 'success',
  )
  const autoId = `auto-${sessionId}`
  expectSuccess(
    await rpc('session.control', {
      sessionId,
      requestId: autoId,
      subtype: 'set_permission_mode',
      payload: { mode: 'auto' },
    }),
  )
  const switched = await eventually(
    () => snapshot(sessionId),
    value => controlResponse(value.events, autoId) !== null,
  )
  const autoResponse = controlResponse(switched.events, autoId)
  expect(autoResponse?.subtype).toBe('success')
  return sessionId
}

async function sendScenario(
  sessionId: string,
  scenario: AutoClassifierScenario,
  target: string,
): Promise<string> {
  const runId = crypto.randomUUID()
  expectSuccess(
    await rpc('session.send', {
      sessionId,
      requestId: `send-${runId}`,
      runId,
      content: `${scenario} TARGET_PATH=${target}`,
    }),
  )
  return runId
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
  )
}

async function waitForCompletedOrPending(
  sessionId: string,
  runId: string,
): Promise<SessionSnapshot> {
  return eventually(
    () => snapshot(sessionId),
    value =>
      value.pendingControls.length > 0 ||
      value.events.some(
        event =>
          event.kind === 'run_state' &&
          event.runId === runId &&
          isRecord(event.payload) &&
          event.payload.state === 'completed',
      ),
  )
}

async function waitForPendingBash(
  sessionId: string,
): Promise<PendingControlSnapshot> {
  const current = await eventually(
    () => snapshot(sessionId),
    value =>
      value.pendingControls.some(
        pending =>
          isRecord(pending.request) && pending.request.tool_name === 'Bash',
      ),
  )
  const pending = current.pendingControls.find(
    candidate =>
      isRecord(candidate.request) && candidate.request.tool_name === 'Bash',
  )
  if (!pending) throw new Error('未收到 Auto classifier 人工 Bash fallback')
  return pending
}

beforeAll(async () => {
  await access(cliEntry)
  const root = await mkdtemp(join(tmpdir(), 'xcodes-native-auto-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const state = join(root, 'service-state')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(config, { recursive: true }),
  ])
  await Bun.write(join(config, 'settings.json'), '{}')
  const git = Bun.spawnSync(['git', 'init', '--quiet'], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (git.exitCode !== 0) {
    throw new Error(`隔离 Git fixture 初始化失败：${git.stderr.toString()}`)
  }

  const fakeApi = startAutoClassifierFakeServer()
  const cli: CliLaunchSpec = {
    command: process.execPath,
    argv: [cliEntry, '--tools', 'Bash'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: 'fake-auto-key',
      ANTHROPIC_BASE_URL: fakeApi.baseUrl,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_TWO_STAGE_CLASSIFIER: '0',
      DISABLE_TELEMETRY: '1',
      USER_TYPE: 'ant',
      NO_PROXY: '127.0.0.1,localhost',
      SHELL: '/bin/zsh',
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
    },
  }
  const service = startLocalService({ token, stateDir: state, defaultCli: cli })
  fixture = { root, workspace, service, fakeApi }
}, 20_000)

afterAll(async () => {
  if (!fixture) return
  await fixture.service.shutdown()
  fixture.fakeApi.stop()
  await rm(fixture.root, { recursive: true, force: true })
})

describe('真实 CLI Auto classifier', () => {
  test('classifier 允许时自动执行工具并发出独立 usage 事件', async () => {
    const scenario = 'NATIVE_AUTO_ALLOW'
    const sessionId = await openAutoSession()
    const target = join(fixture.workspace, `allow-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, scenario, target)
    const current = await waitForCompletedOrPending(sessionId, runId)
    expect(requestKinds(scenario)).toEqual(
      expect.arrayContaining(['main', 'classifier']),
    )
    expect(current.pendingControls).toHaveLength(0)

    expect(await readFile(target, 'utf8')).toBe(scenario)
    expect(classifierStatuses(current, scenario)).toEqual(
      expect.arrayContaining(['checking', 'allowed']),
    )
    const classifierEvent = current.events.find(
      event =>
        event.kind === 'cli_message' &&
        isRecord(event.payload) &&
        event.payload.subtype === 'auto_mode_classifier' &&
        event.payload.status === 'allowed',
    )
    expect(classifierEvent?.payload).toMatchObject({
      usage_scope: 'classifier_call',
      usage_included_in_result: false,
    })
  }, 30_000)

  test('classifier 拒绝时工具不执行且轮次自行完成', async () => {
    const scenario = 'NATIVE_AUTO_BLOCK'
    const sessionId = await openAutoSession()
    const target = join(fixture.workspace, `block-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, scenario, target)
    const current = await waitForCompletedOrPending(sessionId, runId)
    expect(requestKinds(scenario)).toEqual(
      expect.arrayContaining(['main', 'classifier']),
    )
    expect(current.pendingControls).toHaveLength(0)

    expect(await access(target).then(() => true, () => false)).toBe(false)
    expect(classifierStatuses(current, scenario)).toEqual(
      expect.arrayContaining(['checking', 'blocked']),
    )
  }, 30_000)

  test('classifier 不可用时进入人工审批，允许后继续执行', async () => {
    const scenario = 'NATIVE_AUTO_UNAVAILABLE'
    const sessionId = await openAutoSession()
    const target = join(fixture.workspace, `unavailable-${sessionId}.txt`)
    const runId = await sendScenario(sessionId, scenario, target)
    const pending = await waitForPendingBash(sessionId)
    const request = isRecord(pending.request) ? pending.request : {}
    const input = isRecord(request.input) ? request.input : {}
    expectSuccess(
      await rpc('session.respond', {
        sessionId,
        requestId: `respond-${crypto.randomUUID()}`,
        cliRequestId: pending.cliRequestId,
        response: { behavior: 'allow', updatedInput: input },
      }),
    )
    const current = await waitForCompleted(sessionId, runId)

    expect(await readFile(target, 'utf8')).toBe(scenario)
    expect(current.pendingControls).toHaveLength(0)
    expect(classifierStatuses(current, scenario)).toEqual(
      expect.arrayContaining(['checking', 'unavailable']),
    )
  }, 30_000)
})
