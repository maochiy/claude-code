import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@proma/shared'

// 测试只验证置顶服务，避免加载 Electron 与会话管理器的其他副作用。
mock.module('./config-paths', () => ({
  getConfigDir: () => join(tmpdir(), 'xcodes-message-pin-electron'),
}))
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: () => undefined,
  getAgentSessionSDKMessages: () => [],
}))

const { createMessagePinService } = await import('./message-pin-service')

const tempDirectories: string[] = []

function createFixture(messages: SDKMessage[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'xcodes-message-pins-'))
  tempDirectories.push(directory)
  return createMessagePinService({
    pinsDirectory: () => directory,
    sessionExists: sessionId => sessionId === 'session-a',
    loadMessages: () => messages,
  })
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('消息置顶持久化', () => {
  test('Given 历史消息存在 When 重复置顶与取消置顶 Then 操作幂等且重新创建服务后仍能读取', () => {
    const messages = [{ type: 'user', uuid: 'message-a', message: { content: 'hi' } }] as SDKMessage[]
    const directory = mkdtempSync(join(tmpdir(), 'xcodes-message-pins-'))
    tempDirectories.push(directory)
    const dependencies = {
      pinsDirectory: () => directory,
      sessionExists: () => true,
      loadMessages: () => messages,
    }
    const first = createMessagePinService(dependencies)

    expect(first.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: true }).messageUuids).toEqual(['message-a'])
    expect(first.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: true }).messageUuids).toEqual(['message-a'])

    const reloaded = createMessagePinService(dependencies)
    expect(reloaded.list('session-a').messageUuids).toEqual(['message-a'])
    expect(reloaded.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: false }).messageUuids).toEqual([])
    expect(reloaded.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: false }).messageUuids).toEqual([])
  })

  test('Given 消息不在历史中 When 请求置顶 Then 明确拒绝且不写入伪造 UUID', () => {
    const service = createFixture([])
    expect(() => service.set({
      sessionId: 'session-a',
      messageUuid: 'missing-message',
      pinned: true,
    })).toThrow('会话历史中不存在消息')
    expect(service.list('session-a').messageUuids).toEqual([])
  })

  test('Given 已置顶消息后来从历史消失 When 读取与取消 Then 标出失效 UUID 且允许清理', () => {
    let messages = [{ type: 'assistant', uuid: 'message-a', message: { content: [] } }] as SDKMessage[]
    const directory = mkdtempSync(join(tmpdir(), 'xcodes-message-pins-'))
    tempDirectories.push(directory)
    const service = createMessagePinService({
      pinsDirectory: () => directory,
      sessionExists: () => true,
      loadMessages: () => messages,
    })
    service.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: true })
    messages = []

    expect(service.list('session-a')).toEqual({
      sessionId: 'session-a',
      messageUuids: ['message-a'],
      missingMessageUuids: ['message-a'],
    })
    expect(service.set({ sessionId: 'session-a', messageUuid: 'message-a', pinned: false }).messageUuids).toEqual([])
  })

  test('Given 会话不存在 When 读取 Then 返回明确错误', () => {
    const service = createFixture([])
    expect(() => service.list('missing-session')).toThrow('Agent 会话不存在')
  })
})
