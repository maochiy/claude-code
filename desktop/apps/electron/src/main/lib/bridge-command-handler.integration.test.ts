import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentSendInput,
  AgentStreamPayload,
} from '@proma/shared'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

interface OutboundMessage {
  chatId: string
  text: string
  meta?: unknown
}

type BridgeModule = typeof import('./bridge-command-handler')
type RegistryModule = typeof import('./agent-headless-runner-registry')
type SettingsModule = typeof import('./settings-service')
type ConfigPathsModule = typeof import('./config-paths')
type EventBusInstanceModule = typeof import('./agent-event-bus-instance')

let bridgeModule: BridgeModule
let registry: RegistryModule
let settings: SettingsModule
let configPaths: ConfigPathsModule
let eventBusInstance: EventBusInstanceModule
let dataRoot: string
let originalDataRoot: string | undefined
const activeHandlers: Array<InstanceType<BridgeModule['BridgeCommandHandler']>> = []

mock.module('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return [] }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
}))

function createDeferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function assistantPayload(text: string): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text }] },
    },
  }
}

function resultPayload(): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function createHandler(source: 'dingtalk' | 'wechat' = 'dingtalk'): {
  handler: InstanceType<BridgeModule['BridgeCommandHandler']>
  outbound: OutboundMessage[]
} {
  const outbound: OutboundMessage[] = []
  const handler = new bridgeModule.BridgeCommandHandler({
    platformName: source === 'dingtalk' ? '钉钉' : '微信',
    source,
    adapter: {
      sendText: async (chatId, text, meta) => {
        outbound.push({ chatId, text, meta })
      },
    },
    onSessionCreated: () => {},
  })
  handler.subscribe()
  activeHandlers.push(handler)
  return { handler, outbound }
}

beforeAll(async () => {
  originalDataRoot = process.env.XCODES_DATA_ROOT
  dataRoot = mkdtempSync(join(tmpdir(), 'xcodes-bridge-headless-'))
  process.env.XCODES_DATA_ROOT = dataRoot

  bridgeModule = await import('./bridge-command-handler')
  registry = await import('./agent-headless-runner-registry')
  settings = await import('./settings-service')
  configPaths = await import('./config-paths')
  eventBusInstance = await import('./agent-event-bus-instance')
  settings.updateSettings({
    agentChannelId: 'test-channel',
    agentModelId: 'test-model',
  })
})

beforeEach(() => {
  registry.resetHeadlessAgentRunnerRegistryForTests()
})

afterEach(() => {
  activeHandlers.splice(0).forEach((handler) => handler.unsubscribe())
  registry.resetHeadlessAgentRunnerRegistryForTests()
})

afterAll(() => {
  if (originalDataRoot === undefined) delete process.env.XCODES_DATA_ROOT
  else process.env.XCODES_DATA_ROOT = originalDataRoot
  rmSync(dataRoot, { recursive: true, force: true })
})

describe('BridgeCommandHandler → headless Agent 隔离接线', () => {
  test('Given 当前会话附件 When 钉钉消息执行完成 Then 传递真实来源与受限权限且终态只回复一次', async () => {
    const { handler, outbound } = createHandler('dingtalk')
    const binding = handler.ensureBinding('chat-attachment')
    expect(binding).not.toBeNull()
    const attachmentDirectory = configPaths.getAgentSessionAttachmentsDir(binding!.sessionId)
    const attachmentPath = join(attachmentDirectory, '说明.txt')
    writeFileSync(attachmentPath, 'fixture', 'utf-8')

    let capturedInput: AgentSendInput | undefined
    let capturedSource: string | undefined
    registry.setHeadlessAgentRunner(async (input, callbacks) => {
      capturedInput = input
      capturedSource = callbacks.source
    })

    await handler.handleIncomingMessage(
      'chat-attachment',
      '读取附件',
      { requestId: 'request-1' },
      [{ absolutePath: attachmentPath, label: '说明.txt', kind: 'file' }],
    )

    expect(capturedSource).toBe('dingtalk')
    expect(capturedInput?.permissionModeOverride).toBe('dontAsk')
    expect(capturedInput?.additionalDirectories).toEqual([realpathSync(attachmentDirectory)])
    expect(capturedInput?.userMessage).toContain(attachmentPath)

    eventBusInstance.agentEventBus.emit(binding!.sessionId, assistantPayload('已完成'))
    eventBusInstance.agentEventBus.emit(binding!.sessionId, resultPayload())
    eventBusInstance.agentEventBus.emit(binding!.sessionId, resultPayload())
    await flushAsyncWork()

    expect(outbound.filter((message) => message.text === '已完成')).toHaveLength(1)
    expect(outbound.find((message) => message.text === '已完成')?.meta).toEqual({ requestId: 'request-1' })
  })

  test('Given 其它会话的附件 When 当前会话发送 Then 拒绝越界且不启动 Agent', async () => {
    const { handler, outbound } = createHandler()
    const binding = handler.ensureBinding('chat-current')
    expect(binding).not.toBeNull()
    const foreignDirectory = configPaths.getAgentSessionAttachmentsDir('foreign-session')
    const foreignPath = join(foreignDirectory, 'foreign.txt')
    writeFileSync(foreignPath, 'fixture', 'utf-8')
    let runCount = 0
    registry.setHeadlessAgentRunner(async () => {
      runCount += 1
    })

    await handler.handleIncomingMessage(
      'chat-current',
      '读取附件',
      undefined,
      [{ absolutePath: foreignPath, label: 'foreign.txt', kind: 'file' }],
    )

    expect(runCount).toBe(0)
    expect(outbound.some((message) => message.text.includes('附件不属于当前会话'))).toBe(true)
    expect(outbound.some((message) => message.text.includes('Agent 处理中'))).toBe(false)
  })

  test('Given 同一外部会话仍在运行 When 第二条消息到达 Then 只启动一次并保留首轮', async () => {
    const { handler, outbound } = createHandler('wechat')
    const runDeferred = createDeferred()
    let runCount = 0
    registry.setHeadlessAgentRunner(async () => {
      runCount += 1
      await runDeferred.promise
    })

    await handler.handleIncomingMessage('chat-concurrent', '第一条')
    await handler.handleIncomingMessage('chat-concurrent', '第二条')

    expect(runCount).toBe(1)
    expect(outbound.filter((message) => message.text.includes('上一条消息仍在处理中'))).toHaveLength(1)

    const binding = handler.getBinding('chat-concurrent')
    eventBusInstance.agentEventBus.emit(binding!.sessionId, assistantPayload('第一条完成'))
    eventBusInstance.agentEventBus.emit(binding!.sessionId, resultPayload())
    runDeferred.resolve()
    await flushAsyncWork()
    expect(outbound.filter((message) => message.text === '第一条完成')).toHaveLength(1)
  })

  test('Given Agent 正在运行 When 收到 stop Then 等真实中断完成后才确认', async () => {
    const { handler, outbound } = createHandler()
    const runDeferred = createDeferred()
    const stopDeferred = createDeferred()
    registry.setHeadlessAgentRunner(async () => {
      await runDeferred.promise
    })
    registry.setAgentStopper(async () => {
      await stopDeferred.promise
    })

    await handler.handleIncomingMessage('chat-stop', '开始')
    const stopPromise = handler.handleIncomingMessage('chat-stop', '/stop')
    await flushAsyncWork()
    expect(outbound.some((message) => message.text === '✅ 已停止 Agent')).toBe(false)

    stopDeferred.resolve()
    await stopPromise
    expect(outbound.some((message) => message.text === '✅ 已停止 Agent')).toBe(true)

    const binding = handler.getBinding('chat-stop')
    const terminalCount = outbound.length
    eventBusInstance.agentEventBus.emit(binding!.sessionId, resultPayload())
    runDeferred.resolve()
    await flushAsyncWork()
    expect(outbound).toHaveLength(terminalCount)
  })

  test('Given headless 同时回调错误并拒绝 Promise When Bridge 结算 Then 只回复一次且保留会话绑定', async () => {
    const { handler, outbound } = createHandler()
    let sessionId = ''
    registry.setHeadlessAgentRunner(async (input, callbacks) => {
      sessionId = input.sessionId
      callbacks.onError('运行失败')
      throw new Error('重复失败')
    })

    await handler.handleIncomingMessage('chat-error', '触发失败')
    await flushAsyncWork()

    expect(outbound.filter((message) => message.text.startsWith('❌ Agent 错误:'))).toHaveLength(1)
    expect(outbound.some((message) => message.text.includes('运行失败'))).toBe(true)
    expect(handler.getBinding('chat-error')?.sessionId).toBe(sessionId)

    eventBusInstance.agentEventBus.emit(sessionId, resultPayload())
    await flushAsyncWork()
    expect(outbound.filter((message) => message.text.startsWith('❌ Agent 错误:'))).toHaveLength(1)
  })
})
