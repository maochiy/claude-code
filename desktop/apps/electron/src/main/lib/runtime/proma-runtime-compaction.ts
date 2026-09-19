/**
 * Proma Runtime 模型压缩策略计算（纯函数）。
 *
 * 主会话与后台任务共用同一份压缩策略：
 * 按模型配置的 contextWindow（未配置时取默认 200000）计算触发阈值，
 * 默认取窗口的 80%。后台 Harness 的自动压缩事件不进入主会话 UI。
 */

import type { Channel, RuntimeModelRoute } from '@proma/shared'

/**
 * 解析模型最终生效的压缩触发占比（0-100 的百分比）。
 *
 * 优先级：模型级 autoCompactRatio → 供应商级 autoCompactRatio。
 * 返回 0-100 之间的数值（已做边界收敛），未配置时返回 undefined 由调用方用默认值。
 */
export function resolveAutoCompactRatio(
  channel: Channel,
  modelId: string,
): number | undefined {
  const configuredModel = channel.models.find((model) => model.id === modelId)
  const ratio = configuredModel?.autoCompactRatio ?? channel.autoCompactRatio
  if (ratio == null) return undefined
  if (!Number.isFinite(ratio)) return undefined
  return Math.min(100, Math.max(0, ratio))
}

/**
 * 按渠道模型配置计算压缩策略。
 *
 * 只投影用户明确配置的占比。真实 CLI 默认阈值由 get_context_usage 返回，
 * Desktop 不猜测未配置模型的 contextWindow 或 80% 默认值。
 */
export function compactionFor(
  channel: Channel,
  modelId: string,
): RuntimeModelRoute['compaction'] {
  const configuredModel = channel.models.find((model) => model.id === modelId)
  if (!configuredModel) return undefined
  const ratio = resolveAutoCompactRatio(channel, modelId)
  if (ratio === undefined) return undefined
  const contextWindow = configuredModel.contextWindow
  return {
    enabled: ratio > 0,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextWindow !== undefined && ratio > 0
      ? { threshold: Math.round(contextWindow * ratio / 100) }
      : {}),
  }
}
