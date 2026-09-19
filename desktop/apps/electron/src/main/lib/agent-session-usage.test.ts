import { describe, expect, test } from 'bun:test'
import { getContextUsageRatioFromLines } from './agent-session-usage'

describe('Agent Session 上下文用量', () => {
  test('Given result 同时保留历史大窗口和当前小窗口 When 计算 Then 使用当前渠道模型容量', () => {
    const ratio = getContextUsageRatioFromLines([JSON.stringify({
      type: 'result',
      subtype: 'success',
      _channelModelId: 'small-model',
      usage: { input_tokens: 80_000, cache_read_input_tokens: 20_000, output_tokens: 2_000 },
      modelUsage: {
        'large-model': { contextWindow: 1_000_000 },
        'small-model': { contextWindow: 200_000 },
      },
    })])

    expect(ratio).toBe(0.5)
  })

  test('Given 压缩边界后跟合成 result When 计算 Then 使用压缩后 token 且保留真实模型容量', () => {
    const ratio = getContextUsageRatioFromLines([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        _channelModelId: 'model-a',
        usage: { input_tokens: 120_000, output_tokens: 2_000 },
        modelUsage: { 'model-a': { contextWindow: 200_000 } },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { post_tokens: 40_000 },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        isSyntheticCompactionResult: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ])

    expect(ratio).toBe(0.2)
  })

  test('Given Runtime 未报告上下文容量 When 计算 Then 保持未知而不推断模型窗口', () => {
    const ratio = getContextUsageRatioFromLines([JSON.stringify({
      type: 'result',
      subtype: 'success',
      _channelModelId: 'model-a',
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
      modelUsage: { 'model-a': {} },
    })])

    expect(ratio).toBeUndefined()
  })
})
