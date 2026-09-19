import { describe, expect, test } from 'bun:test'
import { runRecoverableAgentSessionClearBoundary } from './agent-session-clear-boundary'
import type { AgentSessionClearTransaction } from './agent-session-clear-transaction'

const transaction: AgentSessionClearTransaction = {
  sessionId: 'desktop-session',
  archiveSessionId: 'archive-session',
  intendedRuntimeSessionId: 'fresh-native-session',
  phase: 'prepared',
  hasArchive: true,
  createdAt: 1,
  updatedAt: 2,
}

describe('Agent 会话清空编排故障边界', () => {
  test('Given Runtime 已成功切换 When 本地 finalize 写索引失败 Then 保留事务且不得回滚归档', async () => {
    let rollbackAttempts = 0

    await expect(runRecoverableAgentSessionClearBoundary({
      intendedRuntimeSessionId: 'fresh-native-session',
      clearRuntime: async () => ({ runtimeSessionId: 'fresh-native-session' }),
      closeRuntime: async () => {},
      loadTransaction: () => transaction,
      finalize: () => { throw new Error('injected finalize failure') },
      rollbackPreflight: () => { rollbackAttempts += 1 },
    })).rejects.toThrow('injected finalize failure')

    expect(rollbackAttempts).toBe(0)
  })

  test('Given Runtime 已关闭但 fresh 启动失败 When 本地 finalize 也失败 Then 保留事务且不得回滚归档', async () => {
    let rollbackAttempts = 0
    const restartRequired = Object.assign(new Error('fresh worker unavailable'), {
      code: 'RUNTIME_CLEAR_RESTART_REQUIRED',
    })

    await expect(runRecoverableAgentSessionClearBoundary({
      intendedRuntimeSessionId: 'fresh-native-session',
      clearRuntime: async () => { throw restartRequired },
      closeRuntime: async () => {},
      loadTransaction: () => transaction,
      finalize: () => { throw new Error('injected deferred finalize failure') },
      rollbackPreflight: () => { rollbackAttempts += 1 },
    })).rejects.toThrow('injected deferred finalize failure')

    expect(rollbackAttempts).toBe(0)
  })

  test('Given Runtime preflight 明确拒绝 When 尚未切换原生会话 Then 执行本地回滚', async () => {
    let rollbackAttempts = 0

    await expect(runRecoverableAgentSessionClearBoundary({
      intendedRuntimeSessionId: 'fresh-native-session',
      clearRuntime: async () => { throw new Error('会话仍有后台任务') },
      closeRuntime: async () => {},
      loadTransaction: () => transaction,
      finalize: () => ({ id: 'desktop-session' }),
      rollbackPreflight: () => { rollbackAttempts += 1 },
    })).rejects.toThrow('会话仍有后台任务')

    expect(rollbackAttempts).toBe(1)
  })

  test('Given Runtime 返回非预留 ID When 关闭该 worker Then 提交预留 ID 供下轮 fresh 启动', async () => {
    let closeAttempts = 0

    const result = await runRecoverableAgentSessionClearBoundary({
      intendedRuntimeSessionId: 'fresh-native-session',
      clearRuntime: async () => ({ runtimeSessionId: 'unexpected-session' }),
      closeRuntime: async () => { closeAttempts += 1 },
      loadTransaction: () => transaction,
      finalize: () => ({ id: 'desktop-session' }),
      rollbackPreflight: () => { throw new Error('不应回滚') },
    })

    expect(closeAttempts).toBe(1)
    expect(result).toEqual({
      session: { id: 'desktop-session' },
      runtimeSessionId: 'fresh-native-session',
      deferredRuntimeRestart: true,
    })
  })
})
