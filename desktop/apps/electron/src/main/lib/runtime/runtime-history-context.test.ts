import { describe, expect, test } from 'bun:test'
import { readSessionMessagesFromString } from '@proma/session-core'
import {
  buildRuntimeHistoryMessages,
  buildRuntimeRetryHistoryMessages,
} from './runtime-history-context'

describe('旧会话上下文迁移', () => {
  test('Given 混合旧扁平与 SDK 历史 When 迁移 Then 保留末条真实回答而不是盲目裁掉', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ role: 'user', content: '项目代号是什么', createdAt: 1 }),
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'text', text: '代号星河' }] } }),
    ].join('\n'))
    expect(buildRuntimeHistoryMessages(messages)).toEqual([
      { role: 'user', content: '项目代号是什么' },
      { role: 'assistant', content: '代号星河' },
    ])
  })

  test('Given 用户前后发送相同文案 When 捕获发送前历史 Then 不按文本删除任何一轮', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'a1', content: [{ type: 'text', text: '第一步' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '继续' }] } }),
    ].join('\n'))
    expect(buildRuntimeHistoryMessages(messages).map((message) => message.content))
      .toEqual(['继续', '第一步', '继续'])
  })

  test('Given 失败回合已有用户消息和部分回复 When 按错误 UUID 原地重试 Then Runtime 历史裁到该用户回合之前', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '旧问题' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'a1', content: [{ type: 'text', text: '旧回答' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '请重试' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', message: { id: 'a2', content: [{ type: 'text', text: '失败前的部分正文' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'error-2', error: { message: '失败' }, message: { content: [{ type: 'text', text: '失败' }] } }),
    ].join('\n'))

    expect(buildRuntimeRetryHistoryMessages(messages, 'error-2')).toEqual({
      historyMessages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ],
      reusePersistedUser: true,
      status: 'matched',
    })
  })

  test('Given 两个回合使用相同文案 When 重试第一条错误 Then 以错误位置定位第一回合', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'error-1', error: { message: '首次失败' }, message: { content: [{ type: 'text', text: '首次失败' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'error-2', error: { message: '再次失败' }, message: { content: [{ type: 'text', text: '再次失败' }] } }),
    ].join('\n'))

    expect(buildRuntimeRetryHistoryMessages(messages, 'error-1')).toEqual({
      historyMessages: [],
      reusePersistedUser: true,
      status: 'matched',
    })
  })

  test('Given 用户回合含图片附件 When 按错误 UUID 重试 Then 仍以该用户消息作为边界', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', data: 'AA==' } }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'error-1', error: { message: '图片处理失败' }, message: { content: [{ type: 'text', text: '图片处理失败' }] } }),
    ].join('\n'))

    expect(buildRuntimeRetryHistoryMessages(messages, 'error-1')).toEqual({
      historyMessages: [],
      reusePersistedUser: true,
      status: 'matched',
    })
  })

  test('Given 错误 UUID 不存在 When 构建重试历史 Then 明确要求持久化本次用户输入且保留历史', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '旧问题' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'a1', content: [{ type: 'text', text: '旧回答' }] } }),
    ].join('\n'))

    expect(buildRuntimeRetryHistoryMessages(messages, 'missing-error')).toEqual({
      historyMessages: buildRuntimeHistoryMessages(messages),
      reusePersistedUser: false,
      status: 'error_not_found',
    })
  })

  test('Given 错误前只有工具结果 When 构建重试历史 Then 不把工具结果误认成用户输入', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'tool-result', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'error-1', error: { message: '失败' }, message: { content: [{ type: 'text', text: '失败' }] } }),
    ].join('\n'))

    expect(buildRuntimeRetryHistoryMessages(messages, 'error-1')).toEqual({
      historyMessages: buildRuntimeHistoryMessages(messages),
      reusePersistedUser: false,
      status: 'user_not_found',
    })
  })
})
