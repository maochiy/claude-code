import type {
  AgentRuntimeContextPolicy,
  AgentRuntimeModelCatalog,
  SDKMessage,
} from '@proma/shared'
import type { AgentContextStatus } from '../atoms/agent-atoms'

export interface RestoredAgentContextUsage {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** 会话累计净输入 tokens（不含缓存；对齐 opencode adjusted input 口径） */
  cumulativeInputTokens?: number
  /** 会话累计缓存读取 tokens（用于计算缓存命中率） */
  cumulativeCacheReadTokens?: number
  /** 会话累计缓存写入 tokens */
  cumulativeCacheCreationTokens?: number
  contextWindow?: number
  contextUsageIsEstimated: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
}

/** CLI get_context_usage 的可选桌面投影。字段缺失表示 Runtime 未提供，不能按 0 补齐。 */
export interface AgentContextUsageBreakdown {
  categories: AgentContextUsageCategory[]
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  estimated?: boolean
  autoCompactThreshold?: number
  autoCompactEnabled?: boolean
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  agents?: Array<{ agentType: string; source: string; tokens: number }>
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
  }
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  apiUsage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
  } | null
}

export interface AgentContextUsageCategory {
  name: string
  tokens: number
  color?: string
  isDeferred?: boolean
}

/**
 * 将 Local service/CLI 的 get_context_usage 原始响应转换为 Renderer 可消费结构。
 * 无效或缺失字段直接省略，尤其不会从模型名或分类合计推测容量。
 */
export function normalizeAgentContextUsageBreakdown(
  value: unknown,
): AgentContextUsageBreakdown | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const categories = Array.isArray(record.categories)
    ? record.categories.flatMap((item): AgentContextUsageCategory[] => {
      const category = asRecord(item)
      const tokens = numberValue(category?.tokens)
      if (!category || typeof category.name !== 'string' || tokens == null) return []
      return [{
        name: category.name,
        tokens,
        ...(typeof category.color === 'string' ? { color: category.color } : {}),
        ...(typeof category.isDeferred === 'boolean' ? { isDeferred: category.isDeferred } : {}),
      }]
    })
    : []
  const apiUsageRecord = asRecord(record.apiUsage)
  const apiUsage = record.apiUsage === null
    ? null
    : apiUsageRecord
      ? {
          inputTokens: numberValue(apiUsageRecord.input_tokens ?? apiUsageRecord.inputTokens) ?? 0,
          outputTokens: numberValue(apiUsageRecord.output_tokens ?? apiUsageRecord.outputTokens) ?? 0,
          cacheCreationTokens: numberValue(
            apiUsageRecord.cache_creation_input_tokens ?? apiUsageRecord.cacheCreationTokens,
          ) ?? 0,
          cacheReadTokens: numberValue(
            apiUsageRecord.cache_read_input_tokens ?? apiUsageRecord.cacheReadTokens,
          ) ?? 0,
        }
      : undefined
  return {
    categories,
    ...(numberValue(record.totalTokens) !== undefined ? { totalTokens: numberValue(record.totalTokens) } : {}),
    ...(numberValue(record.maxTokens) !== undefined ? { maxTokens: numberValue(record.maxTokens) } : {}),
    ...(numberValue(record.rawMaxTokens) !== undefined ? { rawMaxTokens: numberValue(record.rawMaxTokens) } : {}),
    ...(numberValue(record.percentage) !== undefined ? { percentage: numberValue(record.percentage) } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.estimated === 'boolean' ? { estimated: record.estimated } : {}),
    ...(numberValue(record.autoCompactThreshold) !== undefined
      ? { autoCompactThreshold: numberValue(record.autoCompactThreshold) }
      : {}),
    ...(typeof record.isAutoCompactEnabled === 'boolean'
      ? { autoCompactEnabled: record.isAutoCompactEnabled }
      : typeof record.autoCompactEnabled === 'boolean'
        ? { autoCompactEnabled: record.autoCompactEnabled }
        : {}),
    ...(apiUsage !== undefined ? { apiUsage } : {}),
  }
}

type ContextUsageSnapshotSource = 'result' | 'assistant' | 'compact'

interface ContextUsageSnapshot {
  value: RestoredAgentContextUsage
  source: ContextUsageSnapshotSource
  createdAt?: number
  index: number
}

function usageWentBackwards(
  current: { inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  previous: { inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined,
): boolean {
  if (!previous) return false
  return current.inputTokens < previous.inputTokens
    || (current.outputTokens ?? 0) < (previous.outputTokens ?? 0)
    || (current.cacheReadTokens ?? 0) < (previous.cacheReadTokens ?? 0)
    || (current.cacheCreationTokens ?? 0) < (previous.cacheCreationTokens ?? 0)
}

function usageDelta(
  current: { inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  previous: { inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  const reset = usageWentBackwards(current, previous)
  return {
    inputTokens: reset ? current.inputTokens : Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    outputTokens: reset ? (current.outputTokens ?? 0) : Math.max(0, (current.outputTokens ?? 0) - (previous?.outputTokens ?? 0)),
    cacheReadTokens: reset ? (current.cacheReadTokens ?? 0) : Math.max(0, (current.cacheReadTokens ?? 0) - (previous?.cacheReadTokens ?? 0)),
    cacheCreationTokens: reset ? (current.cacheCreationTokens ?? 0) : Math.max(0, (current.cacheCreationTokens ?? 0) - (previous?.cacheCreationTokens ?? 0)),
  }
}

/** 按 CCB 规范化后的模型 ID 从轻量 Context Policy 目录读取策略。 */
export function resolveAgentContextPolicy(
  catalog: AgentRuntimeModelCatalog | undefined,
  modelId: string | null | undefined,
): AgentRuntimeContextPolicy | undefined {
  if (!catalog || !modelId) return undefined
  const normalizedModelId = modelId.replace(/\[1m\]$/i, '')
  return catalog.contextPolicy.models.find(
    policy =>
      policy.model === modelId || policy.model === normalizedModelId,
  )
}

/** 活跃轮只显示该轮的执行快照；空闲时展示下一轮选定模型的配置。 */
export function resolveAgentContextStatus(
  status: AgentContextStatus,
  catalog: AgentRuntimeModelCatalog | undefined,
  modelId: string | null | undefined,
  active: boolean,
): AgentContextStatus {
  if (active) return status
  const policy = resolveAgentContextPolicy(catalog, modelId)
  if (!policy) return status
  return {
    ...status,
    contextWindow: policy.contextWindow,
    autoCompactEnabled: catalog!.contextPolicy.autoCompactEnabled,
    autoCompactThreshold: policy.autoCompactThreshold,
    effectiveContextWindow: policy.effectiveContextWindow,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function readUsage(value: unknown): Omit<RestoredAgentContextUsage, 'contextUsageIsEstimated'> | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const directInput = numberValue(usage.input_tokens)
  if (directInput == null) return undefined
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? 0
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens) ?? 0
  return {
    inputTokens: directInput + cacheReadTokens + cacheCreationTokens,
    outputTokens: numberValue(usage.output_tokens),
    cacheReadTokens,
    cacheCreationTokens,
  }
}

function readContextWindow(value: unknown): number | undefined {
  const usageByModel = asRecord(value)
  if (!usageByModel) return undefined
  let contextWindow: number | undefined
  for (const modelUsage of Object.values(usageByModel)) {
    const candidate = numberValue(asRecord(modelUsage)?.contextWindow)
    if (candidate == null) continue
    contextWindow = Math.max(contextWindow ?? 0, candidate)
  }
  return contextWindow
}

function sourcePriority(source: ContextUsageSnapshotSource): number {
  switch (source) {
    case 'compact':
      return 3
    case 'assistant':
      return 2
    case 'result':
      return 1
  }
}

function shouldReplaceSnapshot(
  current: ContextUsageSnapshot | undefined,
  candidate: ContextUsageSnapshot,
): boolean {
  if (!current) return true

  if (candidate.createdAt != null || current.createdAt != null) {
    if (candidate.createdAt == null) return false
    if (current.createdAt == null) return true
    if (candidate.createdAt !== current.createdAt) {
      return candidate.createdAt > current.createdAt
    }

    const candidatePriority = sourcePriority(candidate.source)
    const currentPriority = sourcePriority(current.source)
    if (candidatePriority !== currentPriority) {
      return candidatePriority > currentPriority
    }
  }

  return candidate.index > current.index
}

/**
 * 从 Proma 本地 SDKMessage 投影恢复最近一次上下文用量。
 *
 * 这只用于圆环冷启动水合，不参与 CCB 的模型上下文恢复。真正的执行上下文仍由
 * runtimeSessionId 对应的 CCB Transcript 通过 session.resume 加载。
 */
export function derivePersistedAgentContextUsage(
  messages: SDKMessage[],
): RestoredAgentContextUsage | undefined {
  let snapshot: ContextUsageSnapshot | undefined
  let contextWindow: number | undefined
  let contextWindowCreatedAt = Number.NEGATIVE_INFINITY
  let contextWindowIndex = -1
  let autoCompactEnabled: boolean | undefined
  let autoCompactThreshold: number | undefined
  let effectiveContextWindow: number | undefined
  let hasAssistantUsageInTurn = false
  let compactResultPending = false
  let previousResultUsage: ReturnType<typeof readUsage>
  // 会话累计（缓存命中率），对齐 opencode adjusted input 口径
  let cumulativeInputTokens = 0
  let cumulativeCacheReadTokens = 0
  let cumulativeCacheCreationTokens = 0

  const accumulateUsage = (usage: { inputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void => {
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheCreation = usage.cacheCreationTokens ?? 0
    cumulativeCacheReadTokens += cacheRead
    cumulativeCacheCreationTokens += cacheCreation
    cumulativeInputTokens += Math.max(0, usage.inputTokens - cacheRead - cacheCreation)
  }

  for (const [index, message] of messages.entries()) {
    const record = asRecord(message)
    if (!record) continue
    const createdAt = numberValue(record._createdAt)

    if (record.type === 'user' && record.parent_tool_use_id == null) {
      hasAssistantUsageInTurn = false
      continue
    }

    if (record.type === 'system' && record.subtype === 'context_compaction_config') {
      const restoredThreshold = numberValue(record.autoCompactThreshold)
      const restoredEffectiveWindow = numberValue(record.effectiveContextWindow)
      if (
        typeof record.autoCompactEnabled === 'boolean'
        && restoredThreshold != null
        && restoredEffectiveWindow != null
      ) {
        autoCompactEnabled = record.autoCompactEnabled
        autoCompactThreshold = restoredThreshold
        effectiveContextWindow = restoredEffectiveWindow
      }
      continue
    }

    if (record.type === 'assistant' && record.parent_tool_use_id == null) {
      const usage = readUsage(asRecord(record.message)?.usage)
      if (!usage || usage.inputTokens <= 0) continue
      accumulateUsage(usage)
      const candidate: ContextUsageSnapshot = {
        value: {
          ...usage,
          contextUsageIsEstimated: false,
        },
        source: 'assistant',
        createdAt,
        index,
      }
      if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
      hasAssistantUsageInTurn = true
      compactResultPending = false
      continue
    }

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const metadata = asRecord(record.compact_metadata)
      const postTokens =
        numberValue(record.compactionEstimatedTokensAfter)
        ?? numberValue(metadata?.post_tokens)
      if (postTokens != null && postTokens > 0) {
        const candidate: ContextUsageSnapshot = {
          value: {
            inputTokens: postTokens,
            contextUsageIsEstimated: true,
          },
          source: 'compact',
          createdAt,
          index,
        }
        if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
      }
      compactResultPending = true
      hasAssistantUsageInTurn = false
      continue
    }

    if (record.type !== 'result') continue

    const reportedWindow = readContextWindow(record.modelUsage)
    const resultCreatedAt = createdAt ?? Number.NEGATIVE_INFINITY
    if (reportedWindow != null && (resultCreatedAt > contextWindowCreatedAt
      || (resultCreatedAt === contextWindowCreatedAt && index > contextWindowIndex))) {
      // 取最新 result 的实际窗口，允许会话切换到更小模型；不能永久保留历史最大值。
      contextWindow = reportedWindow
      contextWindowCreatedAt = resultCreatedAt
      contextWindowIndex = index
    }

    const cumulativeResultUsage = readUsage(record.usage)
    const incrementalResultUsage = cumulativeResultUsage
      ? usageDelta(cumulativeResultUsage, previousResultUsage)
      : undefined
    if (cumulativeResultUsage) previousResultUsage = cumulativeResultUsage

    const isCompactionResult =
      compactResultPending || record.isSyntheticCompactionResult === true
    compactResultPending = false
    if (isCompactionResult || hasAssistantUsageInTurn) {
      hasAssistantUsageInTurn = false
      continue
    }

    const usage = incrementalResultUsage
    if (usage && usage.inputTokens > 0) {
      accumulateUsage(usage)
      const candidate: ContextUsageSnapshot = {
        value: {
          ...usage,
          // CLI result.usage 是进程累计值，差额只能作为历史兼容估算；实时真值应来自 get_context_usage。
          contextUsageIsEstimated: true,
        },
        source: 'result',
        createdAt,
        index,
      }
      if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
    }
    hasAssistantUsageInTurn = false
  }

  if (!snapshot) return undefined
  return {
    ...snapshot.value,
    cumulativeInputTokens,
    cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens,
    contextWindow,
    ...(autoCompactEnabled !== undefined && { autoCompactEnabled }),
    ...(autoCompactThreshold !== undefined && { autoCompactThreshold }),
    ...(effectiveContextWindow !== undefined && { effectiveContextWindow }),
  }
}
