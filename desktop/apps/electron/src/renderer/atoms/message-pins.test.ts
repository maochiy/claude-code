import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentMessagePinsSnapshot } from '@proma/shared'
import {
  agentMessagePinsAtomFamily,
  loadAgentMessagePinsAtom,
  setAgentMessagePinAtom,
} from './message-pins'

const originalWindow = globalThis.window

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

function installApi(snapshot: AgentMessagePinsSnapshot): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        getAgentMessagePins: async () => snapshot,
        setAgentMessagePin: async (input: { sessionId: string; messageUuid: string; pinned: boolean }) => ({
          sessionId: input.sessionId,
          messageUuids: input.pinned ? [input.messageUuid] : [],
          missingMessageUuids: [],
        }),
      },
    },
  })
}

describe('消息置顶 atoms', () => {
  test('Given 会话重载 When 加载持久化快照 Then 恢复置顶和失效 UUID', async () => {
    installApi({
      sessionId: 'session-a',
      messageUuids: ['message-a', 'missing-message'],
      missingMessageUuids: ['missing-message'],
    })
    const store = createStore()
    await store.set(loadAgentMessagePinsAtom, { sessionId: 'session-a' })

    expect(store.get(agentMessagePinsAtomFamily('session-a'))).toEqual({
      sessionId: 'session-a',
      messageUuids: ['message-a', 'missing-message'],
      missingMessageUuids: ['missing-message'],
      status: 'ready',
    })
  })

  test('Given 未置顶消息 When 设置期望状态 Then atom 使用主进程真实结果更新', async () => {
    installApi({ sessionId: 'session-a', messageUuids: [], missingMessageUuids: [] })
    const store = createStore()
    await store.set(setAgentMessagePinAtom, {
      sessionId: 'session-a',
      messageUuid: 'message-a',
      pinned: true,
    })
    expect(store.get(agentMessagePinsAtomFamily('session-a')).messageUuids).toEqual(['message-a'])
  })
})
