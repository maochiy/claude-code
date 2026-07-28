import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  isTerminalTurnMessage,
  TurnIdleBarrier,
} from './turnLifecycle.js'

describe('Desktop Turn 生命周期', () => {
  test('Given QueryEngine 已产出 result When Worker 消费消息 Then 立即识别为 Turn 终止边界', () => {
    const result = {
      type: 'result',
      subtype: 'success',
    } as SDKMessage

    expect(isTerminalTurnMessage(result)).toBe(true)
    expect(
      isTerminalTurnMessage({ type: 'assistant' } as SDKMessage),
    ).toBe(false)
  })

  test('Given Stop 发生在运行中 When QueryEngine 尚未退出 Then Stop 必须等待 idle', async () => {
    const barrier = new TurnIdleBarrier()
    let stopped = false
    const pendingStop = barrier.wait(true).then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)

    barrier.resolve()
    await pendingStop
    expect(stopped).toBe(true)
  })

  test('Given Session 已空闲 When Stop 到达 Then 立即完成', async () => {
    const barrier = new TurnIdleBarrier()
    await barrier.wait(false)
  })
})
