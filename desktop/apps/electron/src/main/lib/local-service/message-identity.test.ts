import { describe, expect, test } from 'bun:test'
import { localCliMessageIdentity } from './message-identity'

describe('原生消息幂等标识', () => {
  test('Given 无 UUID 状态 When 序号或代次不同 Then 不合并状态', () => {
    expect(localCliMessageIdentity({ type: 'system', _runtimeGeneration: 1, _runtimeSequence: 1 })).not.toBe(
      localCliMessageIdentity({ type: 'system', _runtimeGeneration: 1, _runtimeSequence: 2 }))
    expect(localCliMessageIdentity({ type: 'system', _runtimeGeneration: 1, _runtimeSequence: 1 })).not.toBe(
      localCliMessageIdentity({ type: 'system', _runtimeGeneration: 2, _runtimeSequence: 1 }))
  })
  test('Given 同一原生消息恢复重放 Then UUID 仍标识同一消息', () => {
    expect(localCliMessageIdentity({ type: 'assistant', uuid: 'native', _runtimeGeneration: 1, _runtimeSequence: 3 }))
      .toBe(localCliMessageIdentity({ type: 'assistant', uuid: 'native', _runtimeGeneration: 2, _runtimeSequence: 7 }))
    expect(localCliMessageIdentity({ type: 'system' })).toBeUndefined()
  })
})
