import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSessionClearTransactionStore,
  recoverAgentSessionClearTransaction,
  resolveAgentSessionIdsExcludedFromUsage,
  type AgentSessionClearTransaction,
} from './agent-session-clear-transaction'

const temporaryDirectories: string[] = []

function createStore(): AgentSessionClearTransactionStore {
  return createStoreFixture().store
}

function createStoreFixture(): { store: AgentSessionClearTransactionStore; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'proma-clear-transaction-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'transactions.json')
  return { store: new AgentSessionClearTransactionStore(filePath), filePath }
}

function beginPrepared(store: AgentSessionClearTransactionStore): AgentSessionClearTransaction {
  store.begin({
    sessionId: 'source-session',
    archiveSessionId: 'archive-session',
    intendedRuntimeSessionId: 'fresh-native-session',
    now: 100,
  })
  return store.markPrepared('source-session', true, 200)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Agent 会话清空事务', () => {
  test('Given 事务日志 JSON 损坏 When 读取或开始新事务 Then 失败关闭且不覆盖原字节', () => {
    const { store, filePath } = createStoreFixture()
    const original = '{"version":1,"transactions":['
    writeFileSync(filePath, original, 'utf-8')

    expect(() => store.list()).toThrow('事务日志损坏')
    expect(() => store.begin({
      sessionId: 'new-session',
      archiveSessionId: 'new-archive',
      intendedRuntimeSessionId: 'new-native',
    })).toThrow('事务日志损坏')
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  test('Given 事务日志版本更新或混入无效记录 When 读取 Then 整份拒绝而不丢弃未知事实', () => {
    const { store, filePath } = createStoreFixture()
    writeFileSync(filePath, JSON.stringify({ version: 2, transactions: [] }), 'utf-8')
    expect(() => store.list()).toThrow('不支持的 Agent 会话清空事务日志版本')

    writeFileSync(filePath, JSON.stringify({
      version: 1,
      transactions: [{ sessionId: 'missing-required-fields' }],
    }), 'utf-8')
    expect(() => store.list()).toThrow('事务日志包含无效记录')
  })

  test('Given 归档复制中崩溃 When 重启恢复 Then 删除不完整归档且保留源会话', () => {
    const store = createStore()
    const transaction = store.begin({
      sessionId: 'source-session',
      archiveSessionId: 'archive-session',
      intendedRuntimeSessionId: 'fresh-native-session',
      now: 100,
    })
    const calls: string[] = []

    const outcome = recoverAgentSessionClearTransaction(store, transaction, {
      rollbackArchive: () => calls.push('rollback-archive'),
      persistRuntimeTarget: () => calls.push('persist-runtime'),
      clearCurrentProjection: () => calls.push('clear-source'),
    })

    expect(outcome).toBe('rolled_back')
    expect(calls).toEqual(['rollback-archive'])
    expect(store.get('source-session')).toBeUndefined()
  })

  test('Given Runtime 切换后写入新 ID 失败 When 再次恢复 Then marker 保留并最终只提交预留 ID', () => {
    const store = createStore()
    const transaction = beginPrepared(store)
    const calls: string[] = []
    let shouldFail = true
    const handlers = {
      rollbackArchive: () => calls.push('rollback-archive'),
      persistRuntimeTarget: (current: AgentSessionClearTransaction) => {
        calls.push(`persist:${current.intendedRuntimeSessionId}`)
        if (shouldFail) throw new Error('injected index write failure')
      },
      clearCurrentProjection: () => calls.push('clear-source'),
    }

    expect(() => recoverAgentSessionClearTransaction(store, transaction, handlers))
      .toThrow('injected index write failure')
    expect(store.get('source-session')).toMatchObject({
      phase: 'prepared',
      intendedRuntimeSessionId: 'fresh-native-session',
    })

    shouldFail = false
    expect(recoverAgentSessionClearTransaction(
      store,
      store.get('source-session')!,
      handlers,
    )).toBe('finalized')
    expect(calls).toEqual([
      'persist:fresh-native-session',
      'persist:fresh-native-session',
      'clear-source',
    ])
    expect(store.get('source-session')).toBeUndefined()
  })

  test('Given Runtime preflight 明确拒绝 When 记录回滚意图后崩溃 Then 重启只删除临时归档', () => {
    const store = createStore()
    beginPrepared(store)
    const rollback = store.markRollbackPending('source-session')
    const calls: string[] = []

    recoverAgentSessionClearTransaction(store, rollback, {
      rollbackArchive: () => calls.push('rollback-archive'),
      persistRuntimeTarget: () => calls.push('persist-runtime'),
      clearCurrentProjection: () => calls.push('clear-source'),
    })

    expect(calls).toEqual(['rollback-archive'])
    expect(store.get('source-session')).toBeUndefined()
  })

  test('Given 投影截断后删除 marker 之前失败 When 重放 Then 幂等写入且不会生成第二个归档', () => {
    const store = createStore()
    const transaction = beginPrepared(store)
    let clearAttempts = 0
    const persistedTargets: string[] = []
    const handlers = {
      rollbackArchive: () => { throw new Error('不应回滚已提交归档') },
      persistRuntimeTarget: (current: AgentSessionClearTransaction) => {
        persistedTargets.push(current.intendedRuntimeSessionId)
      },
      clearCurrentProjection: () => {
        clearAttempts += 1
        if (clearAttempts === 1) throw new Error('injected projection write failure')
      },
    }

    expect(() => recoverAgentSessionClearTransaction(store, transaction, handlers))
      .toThrow('injected projection write failure')
    expect(store.list()).toHaveLength(1)

    recoverAgentSessionClearTransaction(store, store.get('source-session')!, handlers)

    expect(persistedTargets).toEqual(['fresh-native-session', 'fresh-native-session'])
    expect(clearAttempts).toBe(2)
    expect(store.list()).toEqual([])
  })

  test('Given 清空处于不同阶段 When 汇总用量 Then 任一旧历史只统计一次', () => {
    const store = createStore()
    const preparing = store.begin({
      sessionId: 'source-session',
      archiveSessionId: 'archive-session',
      intendedRuntimeSessionId: 'fresh-native-session',
    })

    expect([...resolveAgentSessionIdsExcludedFromUsage([preparing])])
      .toEqual(['archive-session'])

    const prepared = store.markPrepared('source-session', true)
    expect([...resolveAgentSessionIdsExcludedFromUsage([prepared])])
      .toEqual(['source-session'])

    const runtimeCleared = store.markRuntimeCleared('source-session')
    expect([...resolveAgentSessionIdsExcludedFromUsage([runtimeCleared])])
      .toEqual(['source-session'])
  })
})
