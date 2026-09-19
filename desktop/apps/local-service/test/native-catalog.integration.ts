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
import {
  startFakeAnthropicServer,
  type FakeAnthropicServer,
} from './fixtures/fake-anthropic-server.ts'

const cliEntry = join(resolveNativeCliRoot(), 'dist', 'cli-bun.js')
const token = 'native-catalog-integration-token'

interface CatalogFixture {
  root: string
  workspace: string
  skills: string
  hookMarker: string
  mcpMarker: string
  service: LocalServiceHandle
  fakeApi: FakeAnthropicServer
}

let fixture: CatalogFixture

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

async function rpc(
  method: string,
  params?: JsonValue,
): Promise<RpcResponse> {
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
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待 catalog CLI 状态超时：${JSON.stringify(value)}`)
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

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

beforeAll(async () => {
  await access(cliEntry)
  const root = await mkdtemp(join(tmpdir(), 'xcodes-native-catalog-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(root, 'claude-config')
  const skills = join(root, 'workspace-skills')
  const hookMarker = join(root, 'hook-ran.txt')
  const mcpMarker = join(root, 'mcp-ran.txt')
  const state = join(root, 'service-state')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(join(skills, 'catalog-fixture'), { recursive: true }),
  ])
  await Bun.write(
    join(skills, 'catalog-fixture', 'SKILL.md'),
    [
      '---',
      'name: catalog-fixture',
      'description: Catalog-only integration fixture.',
      '---',
      '',
      'Return the catalog fixture result.',
    ].join('\n'),
  )
  const hookCommand = `/bin/sh -c 'printf hook > "${hookMarker}"'`
  const settingsPath = join(config, 'catalog-settings.json')
  await Bun.write(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCommand }] }],
      },
    }),
  )
  const mcpConfig = JSON.stringify({
    mcpServers: {
      malicious_catalog_fixture: {
        type: 'stdio',
        command: '/bin/sh',
        args: ['-c', `printf mcp > "${mcpMarker}"`],
      },
    },
  })
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
      '--catalog-only',
      '--settings',
      settingsPath,
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
    ],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: 'fake-catalog-key',
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
  const service = startLocalService({ token, stateDir: state, defaultCli: cli })
  fixture = {
    root,
    workspace,
    skills,
    hookMarker,
    mcpMarker,
    service,
    fakeApi,
  }
}, 20_000)

afterAll(async () => {
  if (!fixture) return
  await fixture.service.shutdown()
  fixture.fakeApi.stop()
  await rm(fixture.root, { recursive: true, force: true })
})

describe('真实 CLI catalog-only 隔离', () => {
  test('Given 恶意 hooks/MCP 与本地 Skill When 只读初始化 Then 仅返回目录并拒绝运行能力', async () => {
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
        payload: { additionalSkillDirectories: [fixture.skills] },
      }),
    )
    const initialized = await eventually(
      () => snapshot(sessionId),
      value => controlResponse(value.events, initializeId) !== null,
    )
    const initialize = controlResponse(initialized.events, initializeId)
    expect(initialize?.subtype).toBe('success')
    const initializeResult = initialize?.response
    expect(isRecord(initializeResult) && Array.isArray(initializeResult.commands))
      .toBe(true)
    const commands = isRecord(initializeResult) && Array.isArray(initializeResult.commands)
      ? initializeResult.commands
      : []
    expect(commands).toContainEqual(
      expect.objectContaining({ name: 'catalog-fixture' }),
    )

    for (const [subtype, payload] of [
      ['side_question', { prompt: 'Do not call a model.' }],
      ['set_model', { model: 'claude-fake-local' }],
    ] as const) {
      const requestId = `${subtype}-${crypto.randomUUID()}`
      expectSuccess(
        await rpc('session.control', {
          sessionId,
          requestId,
          subtype,
          payload,
        }),
      )
      const current = await eventually(
        () => snapshot(sessionId),
        value => controlResponse(value.events, requestId) !== null,
      )
      const response = controlResponse(current.events, requestId)
      expect(response?.subtype).toBe('error')
      expect(String(response?.error)).toContain('Catalog-only')
    }

    expectSuccess(
      await rpc('session.send', {
        sessionId,
        requestId: `send-${sessionId}`,
        runId: crypto.randomUUID(),
        content: 'This catalog message must be ignored.',
      }),
    )
    await Bun.sleep(200)
    expect(fixture.fakeApi.requests).toHaveLength(0)
    expect(await fileExists(fixture.hookMarker)).toBe(false)
    expect(await fileExists(fixture.mcpMarker)).toBe(false)

    expectSuccess(await rpc('session.close', { sessionId }))
    expect(fixture.service.manager.size).toBe(0)
    expect(await fileExists(fixture.hookMarker)).toBe(false)
    expect(await fileExists(fixture.mcpMarker)).toBe(false)
  }, 30_000)
})
