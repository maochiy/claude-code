/**
 * Proma Runtime 的 本地 CLI 路由层。
 *
 * RuntimeId 暂时保留历史联合类型用于读取旧会话，但所有查询和 Session 操作
 * 都只委托给 LocalCliRuntimeAdapter。这里不得重新注册 Hermes、Codex、Claude Code
 * 或 CCB 的可执行入口。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntimeSessionOperationInput,
  AgentRuntimeClearResult,
  AgentRuntimeForkResult,
  AgentRuntimeRewindResult,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
  ThinkingConfig,
  ThinkingEffortLevel,
} from '@proma/shared'
import { LocalCliRuntimeAdapter } from '../local-service/runtime-adapter'
import { EXECUTABLE_RUNTIME_ID } from './executable-runtime-policy'

export class RuntimeAdapterRouter implements AgentProviderAdapter {
  private readonly runtime: AgentProviderAdapter
  private readonly sessions = new Set<string>()
  private disposePromise: Promise<void> | null = null

  constructor(runtimeAdapter: AgentProviderAdapter = new LocalCliRuntimeAdapter()) {
    this.runtime = runtimeAdapter
  }

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    this.sessions.add(input.sessionId)
    return this.runtime.query({
      ...input,
      runtimeId: EXECUTABLE_RUNTIME_ID,
      modelRoute: input.modelRoute
        ? { ...input.modelRoute, runtimeId: EXECUTABLE_RUNTIME_ID }
        : undefined,
    })
  }

  abort(sessionId: string): Promise<void> {
    return this.runtime.abort(sessionId)
  }

  /** 当前 Runtime 是否暴露单个后台任务停止能力。 */
  canStopTask(sessionId: string, taskId: string): boolean {
    const runtime = this.runtime as AgentProviderAdapter & {
      canStopTask?: (sessionId: string, taskId: string) => boolean
    }
    return runtime.canStopTask?.(sessionId, taskId) ?? false
  }

  /**
   * 只委托 Runtime 的真实单任务控制方法；不使用 abort(sessionId) 冒充单任务停止。
   */
  stopTask(sessionId: string, taskId: string): Promise<void> {
    const stopTask = (this.runtime as AgentProviderAdapter & {
      stopTask?: (sessionId: string, taskId: string) => Promise<void>
    }).stopTask
    if (!stopTask) {
      return Promise.reject(new Error('当前 Runtime 不支持单独停止后台任务。'))
    }
    return stopTask.call(this.runtime, sessionId, taskId)
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    await this.runtime.closeSession?.(sessionId)
  }

  interruptQuery(sessionId: string): Promise<void> {
    return this.runtime.interruptQuery?.(sessionId) ?? this.abort(sessionId)
  }

  sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    return this.runtime.sendQueuedMessage?.(sessionId, message, options)
      ?? Promise.reject(new Error('本地 CLI 不支持队列消息。'))
  }

  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return this.runtime.setPermissionMode?.(sessionId, mode)
      ?? Promise.reject(new Error('当前执行内核不支持切换权限模式。'))
  }

  async updateRuntimeConfig(sessionId: string, updates: { model?: string; thinkingConfig?: ThinkingConfig; effortLevel?: ThinkingEffortLevel }): Promise<boolean> {
    const runtime = this.runtime as LocalCliRuntimeAdapter
    return runtime.updateRuntimeConfig ? runtime.updateRuntimeConfig(sessionId, updates) : false
  }

  setBackgroundMessageHandler(handler: (sessionId: string, message: SDKMessage) => void): void {
    if (this.runtime instanceof LocalCliRuntimeAdapter) this.runtime.onBackgroundMessage = handler
  }

  readTaskOutput(sessionId: string, taskId: string): Promise<string | null> {
    return (this.runtime as LocalCliRuntimeAdapter).readTaskOutput(sessionId, taskId)
  }

  getContextUsage(sessionId: string): Promise<Record<string, unknown>> {
    return (this.runtime as LocalCliRuntimeAdapter).getContextUsage(sessionId)
  }

  getCommandCatalog(sessionId: string): Promise<Record<string, unknown>> {
    return (this.runtime as LocalCliRuntimeAdapter).getCommandCatalog(sessionId)
  }
  hasSession(sessionId: string): boolean {
    return this.runtime instanceof LocalCliRuntimeAdapter && this.runtime.hasSession(sessionId)
  }
  async prepareSession(input: AgentRuntimeSessionOperationInput & { channelId?: string }): Promise<void> {
    if (!(this.runtime instanceof LocalCliRuntimeAdapter)) throw new Error('执行内核不支持预载能力目录')
    await this.runtime.prepareSession(input)
    this.sessions.add(input.sessionId)
  }
  setAutoCompact(sessionId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return (this.runtime as LocalCliRuntimeAdapter).setAutoCompact(sessionId, enabled)
  }

  async invalidateChannelConfiguration(_channelId: string): Promise<void> {
    // 每次查询的配置指纹包含渠道和凭据 revision；下一次执行前受控重建。
  }

  async getExecutionGraph(
    sessionId: string,
  ): Promise<import('@proma/shared').AgentRuntimeExecutionGraph> {
    return (this.runtime as LocalCliRuntimeAdapter).getExecutionGraph(sessionId)
  }

  async getSubagentTranscript(
    sessionId: string,
    executionNodeId: string,
  ): Promise<import('@proma/shared').AgentRuntimeSubagentTranscript> {
    return (this.runtime as LocalCliRuntimeAdapter).getSubagentTranscript(sessionId, executionNodeId)
  }

  forkSession(
    input: AgentRuntimeSessionOperationInput,
    upToMessageUuid?: string,
  ): Promise<AgentRuntimeForkResult> {
    return this.requireSession(input.sessionId).forkSession?.(input, upToMessageUuid)
      ?? Promise.reject(new Error('本地 CLI 不支持 Session 分叉。'))
  }

  rewindSession(
    input: AgentRuntimeSessionOperationInput,
    messageUuid: string,
  ): Promise<AgentRuntimeRewindResult> {
    return this.requireSession(input.sessionId).rewindSession?.(input, messageUuid)
      ?? Promise.reject(new Error('本地 CLI 不支持 Session 回退。'))
  }

  async clearSession(
    input: AgentRuntimeSessionOperationInput,
  ): Promise<AgentRuntimeClearResult> {
    const clearSession = this.requireSession(input.sessionId).clearSession
    if (!clearSession) throw new Error('本地 CLI 不支持清空会话上下文。')
    const result = await clearSession.call(this.runtime, input)
    this.sessions.add(input.sessionId)
    return result
  }

  compactSession(input: AgentRuntimeSessionOperationInput, instructions?: string): Promise<void> {
    return this.requireSession(input.sessionId).compactSession?.(input, instructions)
      ?? Promise.reject(new Error('本地 CLI 不支持上下文压缩。'))
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.resolve(this.runtime.dispose()).then(() => {
        this.sessions.clear()
      })
    }
    await this.disposePromise
  }

  private requireSession(sessionId: string): AgentProviderAdapter {
    // 空闲或应用重启后的操作由适配器根据原生 ID 恢复，不要求先发一条消息。
    return this.runtime
  }
}
