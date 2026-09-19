import { describe, expect, test } from 'bun:test'
import { jumpToAgentMessage } from './MessagePinAction'

describe('置顶消息跳转', () => {
  test('Given 目标消息已加载 When 跳转 Then 居中平滑滚动到完全匹配的 UUID', () => {
    const calls: ScrollIntoViewOptions[] = []
    const elements = [{
      dataset: { nativeMessageUuid: 'other-message' },
      scrollIntoView: () => { throw new Error('不应滚动到其他消息') },
    }, {
      dataset: { nativeMessageUuid: 'target-message' },
      scrollIntoView: (options: ScrollIntoViewOptions) => { calls.push(options) },
    }]
    const root = {
      querySelectorAll: () => elements,
    } as unknown as ParentNode

    expect(jumpToAgentMessage('target-message', root)).toBe(true)
    expect(calls).toEqual([{ behavior: 'smooth', block: 'center' }])
  })

  test('Given 置顶 UUID 已不在当前历史 When 跳转 Then 返回 false 供入口显式提示', () => {
    const root = {
      querySelectorAll: () => [],
    } as unknown as ParentNode
    expect(jumpToAgentMessage('missing-message', root)).toBe(false)
  })
})
