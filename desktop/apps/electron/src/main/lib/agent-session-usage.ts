/**
 * 读取一个 Agent session 当前的上下文占用率。
 *
 * 用途：automation 调度器在 daily 模式下决定是否要切到新会话——
 * 同一自然日内即便上次运行成功，如果上下文已经接近窗口上限，
 * 继续往里塞会导致本次运行刚开始就触发 SDK 自动压缩，得不偿失。
 *
 * 数据来源：~/.proma/agent-sessions/{id}.jsonl 里最后一条带 usage 的消息。
 * 优先级：
 * 1. SDK result 消息（subtype=success/error_*）：usage + 当前渠道模型的 contextWindow
 * 2. compact_boundary：沿用最近真实 result 的容量，使用压缩后的 context token
 * 3. SDK assistant 消息：仅有 message.usage、没有 Runtime contextWindow 时返回未知
 * 4. 都拿不到：返回 undefined（占用率未知），调度器按"保守复用"处理
 *
 * 已用 token 口径与渲染层（useGlobalAgentListeners / SDKMessageRenderer）保持一致：
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 * 开启 prompt caching 后上下文绝大部分落在 cache_read 上，只取 input_tokens 会把
 * 真实占用率严重低估、令 daily 安全阀几乎无法触发。
 *
 * 性能：从文件尾部反向解析，通常命中最新真实 result 即返回；压缩场景只继续
 * 回溯到最近真实 result 取得 Runtime 容量，避免建立整份会话对象图。
 */

import { calculateContextUsageRatio, pickRuntimeReportedContextWindow } from '@proma/shared'
import type { SDKAssistantMessage, SDKResultMessage } from '@proma/shared'
import { existsSync, readFileSync } from 'node:fs'
import { getAgentSessionMessagesPath } from './config-paths'

interface UsageTokens {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 与渲染层一致的"已用上下文 token"口径：base input + 两类 cache token。
 */
function sumUsedTokens(usage: UsageTokens): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

export function getSessionContextUsageRatio(sessionId: string): number | undefined {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  let lines: string[]
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n')
  } catch {
    return undefined
  }

  return getContextUsageRatioFromLines(lines)
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** 从已读取的 JSONL 行恢复上下文比例，便于对固定夹具做无文件副作用验收。 */
export function getContextUsageRatioFromLines(lines: readonly string[]): number | undefined {
  let compactedUsedTokens: number | undefined

  // 从尾部反向找最后一条带 usage 的 SDK 消息（result 优先，因为它带 modelUsage.contextWindow）。
  // 命中即返回，绝大多数情况下只需解析最后一行（result）或最后几行。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const msg = parsed as { type?: string }

    if (msg.type === 'system') {
      const system = parsed as {
        subtype?: string
        compactionEstimatedTokensAfter?: number
        compact_metadata?: { post_tokens?: number }
      }
      if (system.subtype === 'compact_boundary' && compactedUsedTokens === undefined) {
        compactedUsedTokens = positiveNumber(
          system.compactionEstimatedTokensAfter ?? system.compact_metadata?.post_tokens,
        )
      }
      continue
    }

    if (msg.type === 'result') {
      const result = parsed as SDKResultMessage
      if (result.isSyntheticCompactionResult) continue
      if (!result.usage) continue
      const usedTokens = compactedUsedTokens ?? sumUsedTokens(result.usage)
      const contextWindow = pickResultContextWindow(result)
      return calculateContextUsageRatio(usedTokens, contextWindow)
    }

    if (msg.type === 'assistant') {
      const asst = parsed as SDKAssistantMessage
      const usage = asst.message?.usage
      if (!usage) continue
      return undefined
    }
  }

  return undefined
}

/**
 * 从 SDK result.modelUsage 多 entry 中选择当前模型的 contextWindow。
 *
 * SDK 0.3.142+ Task 工具默认启用后，单次 result 可能包含多个模型（主对话 + 子 agent），
 * modelUsage 会保留主模型、子 Agent 和历史模型多个 entry。优先使用持久化在
 * result 上的 `_channelModelId` 精确匹配当前模型，允许会话从大窗口切到小窗口。
 * 旧记录没有当前模型身份时才回退最大 Runtime 报告值，保持历史兼容。
 *
 * 只使用 CCB Runtime 明确返回的有效 contextWindow，不根据模型名或 Provider 推断。
 */
function pickResultContextWindow(result: SDKResultMessage): number | undefined {
  const selectedModelId = result._channelModelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  if (selectedModelId && result.modelUsage) {
    for (const [modelId, usage] of Object.entries(result.modelUsage)) {
      if (modelId.trim().toLowerCase().replace(/\[1m\]$/i, '') !== selectedModelId) continue
      const contextWindow = positiveNumber(usage?.contextWindow)
      if (contextWindow !== undefined) return contextWindow
    }
  }
  return pickRuntimeReportedContextWindow(result.modelUsage)
}
