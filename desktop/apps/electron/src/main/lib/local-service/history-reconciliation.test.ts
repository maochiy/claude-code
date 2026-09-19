import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { reconcileNativeHistory } from './history-reconciliation'

function message(uuid: string): SDKMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: uuid }] } } as SDKMessage
}
const ids = (messages: SDKMessage[]): unknown[] => messages.map(item => (item as Record<string, unknown>).uuid)

describe('原生历史恢复投影', () => {
  test('Given 流缺少中间消息 When 按原生顺序恢复 Then 填回缺口并保留桌面事件和已保存元数据', () => {
    const first = { ...message('a'), _channelModelId: 'chosen-model' } as SDKMessage
    const status = { type: 'system', subtype: 'local-status' } as SDKMessage
    const result = reconcileNativeHistory([first, status, message('c')], [message('a'), message('b'), message('c')])
    expect(ids(result.messages)).toEqual(['a', undefined, 'b', 'c'])
    expect(result.messages[0]).toBe(first)
    expect(result.messages[1]).toBe(status)
    expect(result.added).toBe(1)
  })

  test('Given 重复恢复或重复分页边界 When 合并 Then 不重复消息或触发新的消耗', () => {
    const first = reconcileNativeHistory([], [message('a'), message('a'), message('b')])
    const next = reconcileNativeHistory(first.messages, [message('a'), message('b')])
    expect(first.added).toBe(2)
    expect(next.added).toBe(0)
    expect(next.messages).toBe(first.messages)
  })

  test('Given 压缩后原生历史仅有后缀 When 恢复 Then 不删除桌面中压缩前的可查历史', () => {
    const result = reconcileNativeHistory([message('old'), message('a')], [message('a'), message('new')])
    expect(ids(result.messages)).toEqual(['old', 'a', 'new'])
  })

  test('Given 原生锚点乱序或缺 UUID When 恢复 Then 明确失败且不修改输入', () => {
    const existing = [message('a'), message('b')]
    expect(() => reconcileNativeHistory(existing, [message('b'), message('a')])).toThrow('顺序冲突')
    expect(() => reconcileNativeHistory(existing, [{ type: 'assistant' } as SDKMessage])).toThrow('缺少稳定 UUID')
    expect(ids(existing)).toEqual(['a', 'b'])
  })
})
