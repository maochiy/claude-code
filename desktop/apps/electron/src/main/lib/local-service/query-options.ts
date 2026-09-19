import type {
  AgentQueryInput,
  AgentRuntimeProviderConfiguration,
  PromaPermissionMode,
  SDKMessage,
  ThinkingConfig,
  ThinkingEffortLevel,
} from '@proma/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'

export type LocalCliMessageContent =
  | string
  | number
  | boolean
  | null
  | LocalCliMessageContent[]
  | { [key: string]: LocalCliMessageContent }

/**
 * 桌面交给原生 CLI 的查询上下文。模型、权限和工作目录由宿主显式指定。
 */
export interface LocalCliAgentQueryOptions extends AgentQueryInput {
  channelId?: string
  env?: Record<string, string | undefined>
  providerConfiguration?: AgentRuntimeProviderConfiguration
  thinkingConfig?: ThinkingConfig
  effortLevel?: ThinkingEffortLevel
  sdkPermissionMode?: PromaPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  systemPrompt?: string
  /** 当前用户消息的原生 CLI content；用于图片等多模态块。 */
  messageContent?: LocalCliMessageContent
  resumeSessionId?: string
  nativeSessionId?: string
  resumeSessionAt?: string
  forkSession?: boolean
  mcpServers?: Record<string, unknown>
  /** 显式限制内置工具；空数组禁用全部，未指定时沿用 CLI 默认目录。 */
  availableBuiltinTools?: string[]
  /** 只加载本次传入的 MCP，不合并用户或项目配置。 */
  strictMcpConfig?: boolean
  maxTurns?: number
  maxBudgetUsd?: number
  fallbackModel?: string
  onSessionId?: (sessionId: string) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (contextWindow: number) => void
  /** 原生终态消息在发布到 Renderer、确认队列消费前同步落盘。 */
  onNativeMessage?: (message: SDKMessage) => void
  /** 断线缺口恢复后的权威原生历史；宿主只更新桌面投影，不重放消息副作用。 */
  onNativeHistory?: (messages: SDKMessage[]) => Promise<void> | void
  compactRequest?: boolean
  /** 仅用于没有当前 CLI 原生 Session 的旧会话迁移，不含本轮输入。 */
  historyMessages?: Array<{ role: string; content: string }>
}
