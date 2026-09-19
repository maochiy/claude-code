import { describe, expect, test } from 'bun:test'
import { readRuntimeSessionContext } from './session-context-access'

describe('Local CLI 会话上下文读取边界', () => {
  test('Given 历史会话未连接 Runtime When 后台只读上下文 Then 不启动 CLI', async () => {
    let prepareCount = 0
    let readCount = 0
    const runtime = {
      hasSession: () => false,
      getContextUsage: async () => {
        readCount++
        return {}
      },
    }

    await expect(readRuntimeSessionContext('history-session', runtime, async () => {
      prepareCount++
    })).rejects.toThrow('尚未连接 Runtime')
    expect(prepareCount).toBe(0)
    expect(readCount).toBe(0)
  })

  test('Given 用户明确刷新详情 When Runtime 尚未连接 Then 准备会话后读取真实用量', async () => {
    let connected = false
    let prepareCount = 0
    const runtime = {
      hasSession: () => connected,
      getContextUsage: async () => ({ totalTokens: 1_200 }),
    }

    const result = await readRuntimeSessionContext('active-session', runtime, async () => {
      prepareCount++
      connected = true
    }, { prepareIfNeeded: true })

    expect(prepareCount).toBe(1)
    expect(result).toEqual({ totalTokens: 1_200 })
  })

  test('Given 用户明确刷新详情 When Runtime 准备失败 Then 原样返回错误且不读取陈旧值', async () => {
    let readCount = 0
    const runtime = {
      hasSession: () => false,
      getContextUsage: async () => {
        readCount++
        return { totalTokens: 9_999 }
      },
    }

    await expect(readRuntimeSessionContext('failed-session', runtime, async () => {
      throw new Error('CLI 启动失败')
    }, { prepareIfNeeded: true })).rejects.toThrow('CLI 启动失败')
    expect(readCount).toBe(0)
  })
})
