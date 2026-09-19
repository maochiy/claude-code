/**
 * Agent Provider 适配器接口
 *
 * 定义 Proma 自己的 Agent 接口层，让底层 SDK 可替换。
 * 当前实现：Claude Code Best Desktop Runtime。
 */

import type {
  PromaPermissionMode,
  AgentRuntimeToolPolicy,
  AgentRuntimeProviderConfiguration,
  SDKMessage,
  SDKUserContentBlock,
  ThinkingConfig,
  ThinkingEffortLevel,
} from './agent'
import type { RuntimeId } from './runtime'
import type { ContextPacket, RuntimeModelRoute } from './runtime-dispatch'

/** SDK 用户消息（队列消息注入用，匹配 SDK SDKUserMessage 结构） */
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  /** Runtime 原生多模态 content；未提供时继续发送文本 content。 */
  messageContent?: SDKUserContentBlock[]
  /** 发送给 Runtime 的原始用户文本；message.content 可包含队列上下文增强。 */
  rawText?: string
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

/** 队列消息注入选项 */
export interface SendQueuedMessageOptions {
  /** 由 Runtime 原子执行 steering，使消息立即介入当前 turn。 */
  interrupt?: boolean
  /** 当前用户输入显式引用的 Skill name（兼容历史 slug 已在编排层归一化） */
  skillMentions?: string[]
  /** runtime/adapter 已接收消息后回调；用于调用方区分失败时是否可回滚本地历史 */
  onAccepted?: () => void
}

/**
 * Agent 查询输入（Provider 无关）
 *
 * 包含所有 Provider 都需要的通用字段。
 * SDK 特定配置通过 Adapter 的扩展输入类型传入。
 */
export interface AgentQueryInput {
  /** 会话 ID */
  sessionId: string
  /** 由主进程 Dispatch Policy 注入的 Runtime；Renderer 不应直接设置。 */
  runtimeId?: RuntimeId
  /** 用户 prompt（已包含上下文注入） */
  prompt: string
  /** 模型 ID */
  model?: string
  /** Agent 工作目录 */
  cwd?: string
  /** 由宿主额外注册到 Runtime 的 Skill 目录（目录内直接包含 skill-name/SKILL.md） */
  additionalSkillDirectories?: string[]
  /** 用户显式授权给该会话的额外目录，传入 CLI 原生权限上下文。 */
  additionalDirectories?: string[]
  /** 中止信号 */
  abortSignal?: AbortSignal
  /** Runtime 专用的宿主环境变量。 */
  env?: Record<string, string | undefined>
  /** Runtime 专用系统提示词。 */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  /** Runtime 必须强制执行的工具白名单/黑名单。 */
  toolPolicy?: AgentRuntimeToolPolicy
  /** Runtime 本轮最多允许的模型轮次。 */
  maxTurns?: number
  /** 由 Proma 主进程编译的统一上下文包。 */
  contextPacket?: ContextPacket
  /** 由 Proma 模型中心解析出的 Runtime 路由。 */
  modelRoute?: RuntimeModelRoute
  /** Runtime 建立/恢复会话后的回调。 */
  onSessionId?: (sessionId: string) => void
  /** 使用 Runtime 原生能力执行一次上下文压缩，不把 /compact 当作普通提示词发送。 */
  compactRequest?: boolean
  /** 会话级自动压缩开关；缺失时使用 Runtime 原生默认，不修改全局设置。 */
  autoCompactEnabled?: boolean
  /**
   * Proma 主进程编译的 MCP Server 配置（materialize 后：内置工具为 http 端点，
   * 外部 server 为 stdio/http 连接信息）。支持 MCP 的 Runtime（如 Pi）据此
   * 连接并暴露其中的工具（例如 collaboration 子 Agent 工具 delegate_*）。
   */
  mcpServers?: Record<string, unknown>
}

/** 空闲 Session 操作所需的 Runtime 启动参数。 */
export interface AgentRuntimeSessionOperationInput {
  sessionId: string
  /** 预留的新原生 Session ID；传入时必须 fresh 启动，不能同时 resume。 */
  nativeSessionId?: string
  /** 分叉前由桌面预留的新会话 ID，同时作为 CLI 新会话 ID。 */
  targetSessionId?: string
  /** 只有用户明确选择恢复文件时才设置。 */
  rewindFiles?: boolean
  rewindUserMessageId?: string
  runtimeSessionId: string
  cwd: string
  model?: string
  fallbackModel?: string
  env?: Record<string, string | undefined>
  providerConfiguration?: AgentRuntimeProviderConfiguration
  permissionMode?: PromaPermissionMode
  /** 会话级自动压缩开关；缺失时使用 Runtime 原生默认，不修改全局设置。 */
  autoCompactEnabled?: boolean
  thinkingConfig?: ThinkingConfig
  effortLevel?: ThinkingEffortLevel
  mcpServers?: Record<string, unknown>
  systemPrompt?: string
  additionalSkillDirectories?: string[]
  additionalDirectories?: string[]
}

export interface AgentRuntimeForkResult {
  runtimeSessionId: string
  messageCount?: number
}

export interface AgentRuntimeRewindResult {
  runtimeSessionId: string
  resumeAtMessageUuid?: string
  fileRewind?: {
    canRewind: boolean
    error?: string
    filesChanged?: string[]
    insertions?: number
    deletions?: number
  }
}

/** Runtime 原生清空结果；旧 Runtime transcript 由 Runtime 自身保留。 */
export interface AgentRuntimeClearResult {
  runtimeSessionId: string
}

/**
 * Agent Provider 适配器接口
 *
 * 职责：接收查询输入，返回 SDKMessage 异步迭代流。
 * SDK 返回完整 JSON 对象（includePartialMessages: false），外部直接透传。
 */
export interface AgentProviderAdapter {
  /** 发起查询，返回 SDKMessage 异步迭代流 */
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  /**
   * 中止指定会话的执行。
   *
   * Promise 完成表示 Runtime 已真正退出当前 Turn，而不是仅收到停止命令。
   */
  abort(sessionId: string): Promise<void>
  /** 关闭并释放指定会话的长期 Runtime Worker。 */
  closeSession?(sessionId: string): Promise<void>
  /**
   * 软中断当前 turn，但保留活跃 Query/Channel 以便继续注入下一条用户消息。
   * 与 abort() 的区别：不杀子进程，允许立即续跑新消息。
   */
  interruptQuery?(sessionId: string): Promise<void>
  /** 释放资源 */
  dispose(): void | Promise<void>
  /** 向活跃查询注入队列消息（可选，仅支持队列的 Provider 实现） */
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void>
  /** 取消队列中的待发送消息（可选） */
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  /** 动态切换活跃查询的权限模式（可选，仅支持 SDK 原生 setPermissionMode 的 Provider） */
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
  /** 使用 Runtime 原生 Session 分叉能力。 */
  forkSession?(
    input: AgentRuntimeSessionOperationInput,
    upToMessageUuid?: string,
  ): Promise<AgentRuntimeForkResult>
  /** 使用 Runtime 原生文件与会话联合回退能力。 */
  rewindSession?(
    input: AgentRuntimeSessionOperationInput,
    messageUuid: string,
  ): Promise<AgentRuntimeRewindResult>
  /** 关闭旧执行上下文并启动全新的原生 Session，不发送字面 /clear。 */
  clearSession?(
    input: AgentRuntimeSessionOperationInput,
  ): Promise<AgentRuntimeClearResult>
  /** 使用 Runtime 原生 compact 能力。 */
  compactSession?(
    input: AgentRuntimeSessionOperationInput,
    instructions?: string,
  ): Promise<void>
}
