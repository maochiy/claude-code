import { describe, expect, test } from 'bun:test'
import {
  awaitAutomationExecution,
  type AutomationExecutionCallbacks,
} from './automation-run-settlement'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: () => resolvePromise?.() }
}

describe('自动任务单次结算', () => {
  test('超时会等待真实停止，停止期间的完成回调不能改写结果', async () => {
    let callbacks: AutomationExecutionCallbacks | undefined
    const stoppedSessionIds: string[] = []
    const stopDeferred = deferred()

    const outcomePromise = awaitAutomationExecution({
      sessionId: 'automation-session-timeout',
      timeoutMs: 5,
      timeoutMessage: '执行超时',
      start: async (nextCallbacks) => {
        callbacks = nextCallbacks
      },
      stopAgent: async sessionId => {
        stoppedSessionIds.push(sessionId)
        await stopDeferred.promise
      },
    })

    await Bun.sleep(15)
    expect(stoppedSessionIds).toEqual(['automation-session-timeout'])
    callbacks?.onComplete()
    callbacks?.onError('迟到错误')
    stopDeferred.resolve()

    await expect(outcomePromise).resolves.toEqual({
      status: 'error',
      error: '执行超时',
      timedOut: true,
      stopSucceeded: true,
    })
    expect(stoppedSessionIds).toEqual(['automation-session-timeout'])
  })

  test('正常完成先取得结算权时不会调用停止', async () => {
    let stopCalls = 0
    const outcome = await awaitAutomationExecution({
      sessionId: 'automation-session-complete',
      timeoutMs: 20,
      timeoutMessage: '执行超时',
      start: async callbacks => callbacks.onComplete(),
      stopAgent: async () => {
        stopCalls += 1
      },
    })

    expect(outcome).toEqual({ status: 'success', timedOut: false })
    await Bun.sleep(30)
    expect(stopCalls).toBe(0)
  })

  test('启动 Promise 拒绝与回调竞争时只采用首个终态', async () => {
    const outcome = await awaitAutomationExecution({
      sessionId: 'automation-session-error',
      timeoutMs: 100,
      timeoutMessage: '执行超时',
      start: async callbacks => {
        callbacks.onError('模型失败')
        throw new Error('迟到拒绝')
      },
      stopAgent: async () => {},
    })

    expect(outcome).toEqual({
      status: 'error',
      error: '模型失败',
      timedOut: false,
    })
  })

  test('超时停止失败会保留失败状态，不能宣称 Agent 已停止', async () => {
    const outcome = await awaitAutomationExecution({
      sessionId: 'automation-session-stop-failed',
      timeoutMs: 5,
      timeoutMessage: '执行超时',
      start: async () => {},
      stopAgent: async () => {
        throw new Error('stop rejected')
      },
    })

    expect(outcome).toEqual({
      status: 'error',
      error: '执行超时；停止 Agent 失败：stop rejected',
      timedOut: true,
      stopSucceeded: false,
      stopError: 'stop rejected',
    })
  })
})
