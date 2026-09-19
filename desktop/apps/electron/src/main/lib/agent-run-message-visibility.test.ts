import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  isVisiblePartialRunMessage,
  isVisibleRunMessage,
} from './agent-run-message-visibility'

describe('Agent 本轮可见消息判定', () => {
  test.each([
    { type: 'system', subtype: 'compacting' },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'system', subtype: 'status', compact_result: 'success' },
  ] as SDKMessage[])('Given /compact 返回压缩状态 %# When 判断本轮是否有可见内容 Then 不误报空回复', (message) => {
    expect(isVisibleRunMessage(message)).toBe(true)
  })

  test('Given SDK 仅返回不可展示的 init 和 result When 判断本轮是否有可见内容 Then 仍允许空回复保护接管', () => {
    expect(isVisibleRunMessage({ type: 'system', subtype: 'init' } as SDKMessage)).toBe(false)
    expect(isVisibleRunMessage({ type: 'result', subtype: 'success' } as SDKMessage)).toBe(false)
  })

  test('Given Local CLI 仅流式返回正文 partial When 判断本轮是否已有输出 Then 不误报空回复', () => {
    expect(isVisiblePartialRunMessage({
      type: 'assistant',
      _partial: true,
      message: { content: [{ type: 'text', text: '这是隔离 UI fixture 的持续流式正文。' }] },
    } as unknown as SDKMessage)).toBe(true)
  })

  test('Given 流式 partial 只有 thinking When 判断本轮是否已有最终输出 Then 保留空回复保护', () => {
    expect(isVisiblePartialRunMessage({
      type: 'assistant',
      _partial: true,
      message: { content: [{ type: 'thinking', thinking: '仅过程思考' }] },
    } as unknown as SDKMessage)).toBe(false)
  })
})
