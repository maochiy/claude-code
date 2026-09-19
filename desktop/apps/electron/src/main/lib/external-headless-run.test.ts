import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@proma/shared'
import {
  resetHeadlessAgentRunnerRegistryForTests,
  setAgentStopper,
  setHeadlessAgentRunner,
} from './agent-headless-runner-registry'
import {
  createSingleExternalErrorSettlement,
  resolveExternalPermissionMode,
  runExternalHeadlessAgent,
  stopExternalHeadlessAgent,
  takeExternalTerminalState,
} from './external-headless-run'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

afterEach(() => {
  resetHeadlessAgentRunnerRegistryForTests()
})

describe('外部消息共用 headless 边界', () => {
  test('Given 会话明确选择权限 When 外部入口运行 Then Default、Bypass、Plan 均不被替换', () => {
    expect(resolveExternalPermissionMode({ permissionMode: 'default' })).toBe('default')
    expect(resolveExternalPermissionMode({ permissionMode: 'bypassPermissions' })).toBe('bypassPermissions')
    expect(resolveExternalPermissionMode({ permissionMode: 'default', planModeEnabled: true })).toBe('plan')
    expect(resolveExternalPermissionMode({ permissionMode: 'plan' })).toBe('plan')
  })

  test('Given 旧会话没有权限配置 When 外部入口运行 Then 安全缺省不会自动 Bypass', () => {
    expect(resolveExternalPermissionMode(undefined)).toBe('dontAsk')
    expect(resolveExternalPermissionMode({})).toBe('dontAsk')
  })

  test('Given 飞书发起 headless When 通过生产共用边界 Then 来源和选择的权限原样进入 runner', async () => {
    let source: string | undefined
    let capturedInput: AgentSendInput | undefined
    setHeadlessAgentRunner(async (input, callbacks) => {
      capturedInput = input
      source = callbacks.source
    })
    const input: AgentSendInput = {
      sessionId: 'feishu-session',
      userMessage: '执行',
      channelId: 'channel',
      permissionModeOverride: resolveExternalPermissionMode({ permissionMode: 'bypassPermissions' }),
    }

    await runExternalHeadlessAgent(input, 'feishu', {
      onError: () => {},
      onComplete: () => {},
      onTitleUpdated: () => {},
    })

    expect(source).toBe('feishu')
    expect(capturedInput?.permissionModeOverride).toBe('bypassPermissions')
  })

  test('Given 飞书停止仍在等待底层确认 When stopper 未完成 Then 不提前 resolve', async () => {
    const stop = deferred()
    let resolved = false
    setAgentStopper(async () => { await stop.promise })

    const stopping = stopExternalHeadlessAgent('feishu-session').then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    stop.resolve()
    await stopping
    expect(resolved).toBe(true)
  })

  test('Given callback、Promise rejection 和迟到 result 竞争 When 结算 Then 每类终态只消费一次', () => {
    const errors: string[] = []
    const settleError = createSingleExternalErrorSettlement((error) => errors.push(error))
    expect(settleError('callback error')).toBe(true)
    expect(settleError(new Error('promise error'))).toBe(false)
    expect(errors).toEqual(['callback error'])

    const states = new Map([['feishu-session', { text: '完成' }]])
    expect(takeExternalTerminalState(states, 'feishu-session')).toEqual({ text: '完成' })
    expect(takeExternalTerminalState(states, 'feishu-session')).toBeUndefined()
  })
})
