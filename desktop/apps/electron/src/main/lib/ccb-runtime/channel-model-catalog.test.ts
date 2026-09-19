import { describe, expect, test } from 'bun:test'
import {
  type Channel,
  type ThinkingEffortLevel,
} from '@proma/shared'
import { buildChannelModelCatalog } from './channel-model-catalog'

function createChannel(
  models: Channel['models'],
): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function getSupportedEffortLevels(
  channel: Channel,
  modelId: string,
  includeDisabledModels = false,
): ThinkingEffortLevel[] | undefined {
  return buildChannelModelCatalog(channel, undefined, includeDisabledModels)
    .models
    .find(model => model.value === modelId)
    ?.supportedEffortLevels
}

describe('Local CLI 离线模型目录', () => {
  test('Given 模型未配置思考等级且 CLI 尚未初始化 When 构建目录 Then 不伪造 effort 能力', () => {
    const channel = createChannel([{
      id: 'legacy-model',
      name: 'Legacy Model',
      enabled: true,
    }])

    expect(getSupportedEffortLevels(channel, 'legacy-model'))
      .toEqual([])
  })

  test('Given 模型显式配置空数组 When 构建目录 Then 保留不支持思考等级语义', () => {
    const channel = createChannel([{
      id: 'no-effort-model',
      name: 'No Effort Model',
      enabled: true,
      thinkingEffortLevels: [],
    }])

    const model = buildChannelModelCatalog(channel).models[0]
    expect(model?.supportedEffortLevels).toEqual([])
    expect(model?.supportsEffort).toBe(false)
  })

  test('Given 模型显式配置思考等级子集 When 构建目录 Then 不使用默认全集覆盖', () => {
    const channel = createChannel([{
      id: 'subset-model',
      name: 'Subset Model',
      enabled: true,
      thinkingEffortLevels: ['high', 'low', 'high'],
    }])

    expect(getSupportedEffortLevels(channel, 'subset-model'))
      .toEqual(['low', 'high'])
  })

  test('Given 旧模型混用 max 与 xhigh When 构建目录 Then 归并为统一四档中的 xhigh 并排序去重', () => {
    const channel = createChannel([{
      id: 'legacy-max-model',
      name: 'Legacy Max Model',
      enabled: true,
      thinkingEffortLevels: ['max', 'medium', 'xhigh', 'max'],
    }])

    expect(getSupportedEffortLevels(channel, 'legacy-max-model'))
      .toEqual(['medium', 'xhigh'])
  })

  test('Given 渠道包含停用模型 When 构建目录 Then includeDisabledModels 控制是否包含且不补写能力', () => {
    const channel = createChannel([
      {
        id: 'enabled-model',
        name: 'Enabled Model',
        enabled: true,
      },
      {
        id: 'disabled-model',
        name: 'Disabled Model',
        enabled: false,
      },
    ])

    expect(buildChannelModelCatalog(channel).models.map(model => model.value))
      .toEqual(['enabled-model'])

    const catalog = buildChannelModelCatalog(channel, undefined, true)
    expect(catalog.models.map(model => model.value))
      .toEqual(['enabled-model', 'disabled-model'])
    expect(catalog.models[1]?.supportedEffortLevels)
      .toEqual([])
    expect(catalog.models[1]?.supportsAdaptiveThinking).toBe(false)
    expect(catalog.models[1]?.supportsFastMode).toBe(false)
    expect(catalog.models[1]?.supportsAutoMode).toBe(false)
  })
})

describe('Local CLI 离线目录上下文策略', () => {
  test('Given 渠道配置了窗口和压缩比例但 CLI 尚未初始化 When 读取目录 Then 保留显式窗口但不声称自动压缩已启用', () => {
    const channel = {
      ...createChannel([
        { id: 'A', name: 'A', enabled: true, contextWindow: 200_000 },
        { id: 'B', name: 'B', enabled: true, contextWindow: 100_000, autoCompactRatio: 70 },
      ]),
      autoCompactRatio: 80,
    }
    const catalog = buildChannelModelCatalog(channel)
    expect(catalog.contextPolicy.autoCompactEnabled).toBe(false)
    expect(catalog.contextPolicy.models.map(policy => policy.autoCompactThreshold))
      .toEqual([200_000, 100_000])
  })

  test('Given 模型未填窗口 When 读取离线目录 Then 使用通用占位窗口且不按模型名推测', () => {
    const channel = createChannel([{ id: 'deepseek-v4-flash', name: '默认窗口模型', enabled: true }])
    const catalog = buildChannelModelCatalog(channel)
    expect(catalog.models[0]?.contextWindow).toBe(200_000)
    expect(catalog.contextPolicy.models[0]).toEqual({
      model: 'deepseek-v4-flash', contextWindow: 200_000,
      effectiveContextWindow: 200_000, autoCompactThreshold: 200_000,
    })
  })

  test('Given 仅供应商比例改变 When CLI 尚未初始化 Then 离线目录不伪造阈值变化', () => {
    const channel = createChannel([{ id: 'A', name: 'A', enabled: true, contextWindow: 200_000 }])
    const before = buildChannelModelCatalog(channel)
    const after = buildChannelModelCatalog({ ...channel, autoCompactRatio: 60 })
    expect(after.models).toEqual(before.models)
    expect(after.contextPolicy).toEqual(before.contextPolicy)
  })
})
