import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import {
  compactionFor,
  resolveAutoCompactRatio,
} from './proma-runtime-compaction'

function channelWith(
  modelId: string,
  provider: string,
  opts: {
    contextWindow?: number
    modelRatio?: number
    channelRatio?: number
  } = {},
): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider,
    baseUrl: 'https://api.test',
    enabled: true,
    defaultModelId: null,
    autoCompactRatio: opts.channelRatio,
    models: [{
      id: modelId,
      name: modelId,
      enabled: true,
      ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
      ...(opts.modelRatio != null ? { autoCompactRatio: opts.modelRatio } : {}),
    }],
    apiMode: 'anthropic_messages',
    capabilities: {},
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Channel
}

describe('Proma Runtime 模型压缩策略计算', () => {
  test('Given 模型未配置压缩占比 When 解析占比 Then 返回 undefined 交由 CLI 使用真实默认策略', () => {
    expect(resolveAutoCompactRatio(channelWith('claude-test', 'anthropic'), 'claude-test'))
      .toBeUndefined()
  })

  test('Given 只配置供应商级占比 When 解析占比 Then 使用供应商级', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { channelRatio: 70 }),
      'claude-test',
    )).toBe(70)
  })

  test('Given 同时配置模型级与供应商级 When 解析占比 Then 模型级优先', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: 60, channelRatio: 70 }),
      'claude-test',
    )).toBe(60)
  })

  test('Given 模型显式配置 contextWindow 与占比 When 计算压缩策略 Then 只投影明确阈值', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, modelRatio: 80 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: 160_000,
      contextWindow: 200_000,
    })
  })

  test('Given 模型配置占比 60 When 计算压缩策略 Then 阈值取窗口的 60%', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, modelRatio: 60 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: 120_000,
      contextWindow: 200_000,
    })
  })

  test('Given 供应商级占比 70 且模型未配置 When 计算压缩策略 Then 阈值取窗口的 70%', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, channelRatio: 70 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: 140_000,
      contextWindow: 200_000,
    })
  })

  test('Given 模型显式配置占比但未配置 contextWindow When 计算压缩策略 Then 不猜测窗口或阈值', () => {
    const compaction = compactionFor(
      channelWith('claude-opus-4-7', 'anthropic', { modelRatio: 80 }),
      'claude-opus-4-7',
    )
    expect(compaction).toEqual({ enabled: true })
  })

  test('Given 模型没有显式占比 When 计算压缩策略 Then 不生成桌面默认策略', () => {
    expect(compactionFor(
      channelWith('claude-opus-4-7', 'anthropic', { contextWindow: 200_000 }),
      'claude-opus-4-7',
    )).toBeUndefined()
  })

  test('Given 显式占比为 0 When 计算压缩策略 Then 关闭自动压缩且不伪造阈值', () => {
    expect(compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, modelRatio: 0 }),
      'claude-test',
    )).toEqual({ enabled: false, contextWindow: 200_000 })
  })

  test('Given 超出边界的占比 When 解析占比 Then 收敛到 0-100', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: 150 }),
      'claude-test',
    )).toBe(100)
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: -20 }),
      'claude-test',
    )).toBe(0)
  })

  test('Given 模型不在渠道中 When 计算压缩策略 Then 不生成策略', () => {
    expect(compactionFor(channelWith('known-model', 'anthropic'), 'unknown-model'))
      .toBeUndefined()
  })
})
