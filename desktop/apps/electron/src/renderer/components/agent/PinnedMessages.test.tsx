import { describe, expect, mock, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKAssistantMessage, SDKUserMessage } from '@proma/shared'
import { agentMessagePinsAtomFamily } from '@/atoms/message-pins'

mock.module('sonner', () => ({
  toast: {
    error: () => undefined,
    warning: () => undefined,
  },
}))

const { buildPinnedMessageEntries, PinnedMessages } = await import('./PinnedMessages')

describe('置顶消息列表', () => {
  test('Given 已置顶用户和助手消息 When 渲染入口 Then 显示短预览、原生角色和取消操作', () => {
    const user: SDKUserMessage = {
      type: 'user',
      uuid: 'pinned-user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '<attached_files>\n- secret.txt: /tmp/secret.txt\n</attached_files>\n请检查这个实现' }] },
    }
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pinned-assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '已完成检查并修复问题。' }] },
    }
    const store = createStore()
    store.set(agentMessagePinsAtomFamily('session-a'), {
      sessionId: 'session-a',
      messageUuids: ['pinned-user', 'pinned-assistant'],
      missingMessageUuids: [],
      status: 'ready',
    })
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PinnedMessages sessionId="session-a" messages={[user, assistant]} />
      </Provider>,
    )

    expect(html).toContain('data-agent-pinned-messages="true"')
    expect(html).toContain('data-pinned-message="user"')
    expect(html).toContain('data-pinned-message="assistant"')
    expect(html).toContain('请检查这个实现')
    expect(html).toContain('已完成检查并修复问题')
    expect(html).not.toContain('/tmp/secret.txt')
    expect(html.match(/aria-label="取消置顶"/g)).toHaveLength(2)
  })

  test('Given 置顶历史已缺失 When 渲染 Then 明确标记且仍保留取消置顶按钮', () => {
    const store = createStore()
    store.set(agentMessagePinsAtomFamily('session-a'), {
      sessionId: 'session-a',
      messageUuids: ['missing-message'],
      missingMessageUuids: ['missing-message'],
      status: 'ready',
    })
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PinnedMessages sessionId="session-a" messages={[]} />
      </Provider>,
    )

    expect(html).toContain('data-pinned-message="missing"')
    expect(html).toContain('该消息已不在当前历史中')
    expect(html).toContain('aria-label="取消置顶"')
  })

  test('Given 助手消息只有工具输入 When 生成预览 Then 不泄漏命令或工具日志', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'tool-only',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'cat /private/credential.log' },
      }] },
    }
    const entries = buildPinnedMessageEntries(
      ['tool-only'],
      [],
      [assistant],
      { missing: '缺失', user: '用户消息', assistant: '助手消息', message: '会话消息' },
    )

    expect(entries[0]?.preview).toBe('助手消息')
    expect(entries[0]?.preview).not.toContain('credential.log')
  })
})
