import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tmpdir(), 'proma-user-usage-test'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
  clipboard: {
    readText: () => '',
    writeText: () => undefined,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
  },
}))

describe('个人用量采集覆盖状态', () => {
  test('Given 没有 Agent 会话 When 汇总覆盖 Then 明确标记为不可用', async () => {
    const { resolveAgentUsageCoverage } = await import('./user-usage-service')

    expect(resolveAgentUsageCoverage({
      totalSessions: 0,
      sessionsWithUsage: 0,
      failedSessions: 0,
    })).toBe('unavailable')
  })

  test('Given 会话存在但没有真实 usage When 汇总覆盖 Then 不伪装成完整零用量', async () => {
    const { resolveAgentUsageCoverage } = await import('./user-usage-service')

    expect(resolveAgentUsageCoverage({
      totalSessions: 3,
      sessionsWithUsage: 0,
      failedSessions: 0,
    })).toBe('unavailable')
  })

  test('Given 只有部分会话含真实 usage When 汇总覆盖 Then 标记为部分覆盖', async () => {
    const { resolveAgentUsageCoverage } = await import('./user-usage-service')

    expect(resolveAgentUsageCoverage({
      totalSessions: 3,
      sessionsWithUsage: 2,
      failedSessions: 0,
    })).toBe('partial')
  })

  test('Given 所有会话可读且都有真实 usage When 汇总覆盖 Then 标记完整', async () => {
    const { resolveAgentUsageCoverage } = await import('./user-usage-service')

    expect(resolveAgentUsageCoverage({
      totalSessions: 3,
      sessionsWithUsage: 3,
      failedSessions: 0,
    })).toBe('complete')
  })

  test('Given 任一会话解析失败 When 汇总覆盖 Then 即使其余有 usage 也标记部分', async () => {
    const { resolveAgentUsageCoverage } = await import('./user-usage-service')

    expect(resolveAgentUsageCoverage({
      totalSessions: 3,
      sessionsWithUsage: 3,
      failedSessions: 1,
    })).toBe('partial')
  })
})
