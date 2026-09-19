import { describe, expect, test } from 'bun:test'
import type { LocalServiceEvent } from './client'
import { parseLocalCliControlResolution } from './control-response'

function event(response: Record<string, unknown>): LocalServiceEvent {
  return {
    type: 'desktop_event', protocolVersion: 1, eventId: 'event-1', sessionId: 'session-1',
    generation: 1, seq: 1, timestamp: Date.now(), source: 'cli', kind: 'control_resolved',
    requestId: 'host-request-1', payload: { response },
  }
}

describe('Local CLI control response projection', () => {
  test('Given control RPC 先返回 accepted 且 CLI 后续返回 success When 解析事件 Then 取真实 response 正文', () => {
    expect(parseLocalCliControlResolution(event({
      subtype: 'success', request_id: 'cli-request-1',
      response: { commands: [{ name: 'review' }], totalTokens: 42 },
    }))).toEqual({
      requestId: 'host-request-1',
      result: { commands: [{ name: 'review' }], totalTokens: 42 },
    })
  })

  test('Given CLI 返回 error 或无效 envelope When 解析事件 Then 生成明确错误而非空数据', () => {
    const failed = parseLocalCliControlResolution(event({
      subtype: 'error', error: { message: 'context unavailable' },
    }))
    expect(failed?.error?.message).toBe('context unavailable')

    const invalid = parseLocalCliControlResolution(event({ accepted: true }))
    expect(invalid?.error?.message).toBe('CLI 返回了无效的控制响应')
  })
})
