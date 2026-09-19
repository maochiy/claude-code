import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
} from '@proma/shared'

interface HeadlessCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
}

type SchedulerModule = typeof import('./automation-scheduler')

let scheduler: SchedulerModule
let capturedInput: AgentSendInput | undefined
let capturedCallbacks: HeadlessCallbacks | undefined
let stopCalls: string[] = []
let releaseRun: (() => void) | undefined

function getCapturedCallbacks(): HeadlessCallbacks | undefined {
  return capturedCallbacks
}

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

mock.module('./agent-service', () => ({
  runAgentHeadless: async (input: AgentSendInput, callbacks: HeadlessCallbacks) => {
    capturedInput = input
    capturedCallbacks = callbacks
    await new Promise<void>((resolve) => { releaseRun = resolve })
  },
  stopAgent: async (sessionId: string) => {
    stopCalls.push(sessionId)
    // 模拟 stopAgent 真正等待底层中断后才返回；迟到 complete 不得改写超时终态。
    capturedCallbacks?.onComplete()
    releaseRun?.()
  },
  isAgentSessionActive: () => false,
}))

beforeAll(async () => {
  scheduler = await import('./automation-scheduler')
})

describe('Automation Scheduler → Agent Service 本地集成', () => {
  test('Given 自动任务超时 When Scheduler 结算 Then 保留来源并只等待一次真实 stopAgent', async () => {
    capturedInput = undefined
    capturedCallbacks = undefined
    stopCalls = []
    releaseRun = undefined

    const outcome = await scheduler.executeAutomationAgentRun({
      agentInput: {
        sessionId: 'automation-local-session',
        userMessage: '执行本地 fixture',
        channelId: 'local-channel',
        workspaceId: 'local-workspace',
        triggeredBy: 'automation',
      },
      timeoutMs: 5,
      timeoutMessage: 'fixture timeout',
    })

    expect(capturedInput).toMatchObject({
      sessionId: 'automation-local-session',
      triggeredBy: 'automation',
    })
    expect(getCapturedCallbacks()?.source).toBe('automation')
    expect(stopCalls).toEqual(['automation-local-session'])
    expect(outcome).toEqual({
      status: 'error',
      error: 'fixture timeout',
      timedOut: true,
      stopSucceeded: true,
    })

    getCapturedCallbacks()?.onError('迟到错误')
    getCapturedCallbacks()?.onComplete()
    await Bun.sleep(10)
    expect(stopCalls).toEqual(['automation-local-session'])
  })
})
