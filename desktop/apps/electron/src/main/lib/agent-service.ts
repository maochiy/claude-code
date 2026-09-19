/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  PromaPermissionMode,
  AgentExternalRunSource,
  AgentMessage,
  ClearAgentSessionInput,
  ClearAgentSessionResult,
  ForkSessionInput,
  AgentSessionMeta,
  ThinkingConfig,
  ThinkingEffortLevel,
  AgentRuntimeExecutionGraph,
  AgentRuntimeSubagentTranscript,
  AgentTurnChangeStats,
} from '@proma/shared'
import { RuntimeAdapterRouter } from './runtime/runtime-adapters'
import { agentEventBus as eventBus } from './agent-event-bus-instance'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionAttachmentsDir, getWorkspaceFilesDir } from './config-paths'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { syncSessionToTask } from './taskboard/taskboard-session-sync'
import {
  setAgentSessionActivityProbe,
  setAgentStopper,
  setHeadlessAgentRunner,
} from './agent-headless-runner-registry'
import { sendAgentStreamComplete } from './agent-completion-payload'
import {
  clearAgentTurnChangeTracking,
  getAgentTurnChangeStats as readAgentTurnChangeStats,
} from './agent-turn-change-tracker'
import { AgentStreamTargetRegistry } from './agent-stream-target-registry'
import { applyRegisteredAgentRuntimeSnapshot } from './agent-collaboration-utils'
import { backgroundTaskService } from './background-task-service-instance'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { getAgentSessionClearBlocker } from './agent-session-clear'
import { createAgentRunAcceptance } from './agent-run-acceptance'
import { applyAndPersistSessionAutoCompact } from './agent-session-auto-compact'
import { readRuntimeSessionContext } from './local-service/session-context-access'

// ===== 实例创建 =====

const adapter = new RuntimeAdapterRouter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)
backgroundTaskService.setRuntimeControl({
  canStopTask: (sessionId, taskId) => adapter.canStopTask(sessionId, taskId),
  stopTask: (sessionId, taskId) => adapter.stopTask(sessionId, taskId),
  readTaskOutput: (sessionId, taskId) => adapter.readTaskOutput(sessionId, taskId),
})

adapter.setBackgroundMessageHandler((sessionId, message) => {
  eventBus.emit(sessionId, { kind: 'sdk_message', message })
})

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 注册协作子会话 EventBus 阻塞事件监听
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch(() => { /* collaboration 模块可能未加载 */ })

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new AgentStreamTargetRegistry<WebContents>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): number {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会清理所有指向旧 wc 的条目（见下方实现）。
  const registrationId = sessionWebContents.register(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return registrationId
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理全部关联项。
    sessionWebContents.deleteTarget(wc)
  })
  return registrationId
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

// ===== EventBus IPC 转发中间件 =====

eventBus.use((sessionId, payload, next) => {
  try {
    backgroundTaskService.observeStreamPayload(sessionId, payload)
  } catch (error) {
    // 后台任务投影失败不能中断 Agent 主消息流。
    console.error(`[后台任务] 记录事件失败: sessionId=${sessionId}`, error)
  }
  // 主轮次结束后后台 CLI 仍可能发任务结果；事件始终带 sessionId，交给全局监听分流。
  const registeredTarget = sessionWebContents.get(sessionId)
  const wc = registeredTarget && !registeredTarget.isDestroyed()
    ? registeredTarget
    : getMainRendererWebContents()
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

interface AgentRunLifecycleCallbacks {
  onAccepted?: () => void
  onRejectedBeforeStart?: (error: Error) => void
}

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
  lifecycle?: AgentRunLifecycleCallbacks,
): Promise<void> {
  let runStarted = false
  const sessionMeta = getAgentSessionMeta(input.sessionId)
  const parentMeta = sessionMeta?.parentSessionId
    ? getAgentSessionMeta(sessionMeta.parentSessionId)
    : undefined
  input = applyRegisteredAgentRuntimeSnapshot(
    input,
    sessionMeta?.registeredAgentSnapshot,
    parentMeta?.planModeEnabled ? 'plan' : parentMeta?.permissionMode,
  )
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  const registrationId = registerWebContents(input.sessionId, webContents)
  // 开始新一轮执行时清除"完成未确认"标记
  try {
    updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false })
  } catch { /* 新会话可能尚未写入索引 */ }
  // 自动任务会话"毕业"：用户手动发消息（非定时触发）即视为接管，标记后该会话回到普通项目列表，
  // 调度器也不再复用它注入新的定时运行。
  if (input.triggeredBy !== 'automation') {
    try {
      const meta = getAgentSessionMeta(input.sessionId)
      if (meta?.sourceAutomationId && !meta.automationGraduated) {
        updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
        // 向渲染进程发送毕业事件，触发 toast 提示
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'automation_graduated' },
        })
      }
    } catch { /* 新会话可能尚未写入索引 */ }
  }
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        if (!runStarted) lifecycle?.onRejectedBeforeStart?.(new Error(error))
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
          })
        }
      },
      onRunStarted: () => {
        // 草稿会话发送首条消息时转为正式会话
        const session = getAgentSessionMeta(input.sessionId)
        if (session?.draft) {
          try {
            updateAgentSessionMeta(input.sessionId, { draft: false })
          } catch (error) {
            console.error('[Agent 服务] 更新草稿会话状态失败:', error)
          }
        }
        // 发送成功开始运行 → 绑定任务 threadId（任务→会话方向已通过 taskboardTaskId 关联）。
        // 即使中途暂停/停止，任务也已绑定会话，任务详情可查看对话。
        // 注意：draft 已在上方置 false，需重新读取会话（旧快照仍为 draft=true，
        // 会导致 syncSessionToTask 的 shouldAutoCreateTask 提前返回而不绑定）。
        const activeSession = getAgentSessionMeta(input.sessionId)
        if (activeSession) {
          try {
            syncSessionToTask(activeSession)
          } catch (error) {
            console.error('[任务看板] 发送时绑定任务失败:', error)
          }
        }
        runStarted = true
        lifecycle?.onAccepted?.()
      },
      onComplete: (messages, opts) => {
        if (!webContents.isDestroyed()) {
          sendAgentStreamComplete(webContents, input, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            // 兼容旧完成回调未携带 startedAt 的路径，保证渲染层能收敛当前运行态。
            startedAt: opts?.startedAt ?? input.startedAt,
            lastStopDurationMs: opts?.lastStopDurationMs,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
      onTranscriptSynced: (messages) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.SESSION_TRANSCRIPT_SYNCED, {
            sessionId: input.sessionId,
            messages,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (!runStarted) lifecycle?.onRejectedBeforeStart?.(new Error(errorMessage))
    if (!webContents.isDestroyed()) {
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: errorMessage,
      })
      sendAgentStreamComplete(webContents, input, {
        messages: [],
        stoppedByUser: false,
      })
    }
  } finally {
    if (!runStarted) {
      lifecycle?.onRejectedBeforeStart?.(new Error('Agent 运行未能启动'))
    }
    // 仅在 orchestrator 已完成此会话时清理映射
    // 且只清理本次注册。立即发送时新回合可能已覆盖同一 session 的目标，
    // 旧回合 finally 不能把新回合的流式 thinking / 工具 / 正文通道删除。
    if (!orchestrator.isActive(input.sessionId)) {
      sessionWebContents.deleteIfCurrent(input.sessionId, registrationId)
    }
  }
}

/**
 * 启动一轮 Agent，但 IPC 仅等待首条用户消息被 Runtime 接收。
 * 生成过程继续由全局流事件驱动，避免把整个回合误当作“发送中”。
 */
export function startAgentRun(
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  const acceptance = createAgentRunAcceptance()
  void runAgent(input, webContents, {
    onAccepted: acceptance.accept,
    onRejectedBeforeStart: acceptance.reject,
  }).catch((error: unknown) => {
    acceptance.reject(error instanceof Error ? error : new Error(String(error)))
  })
  return acceptance.promise
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
    onTitleUpdated: (title: string) => void
    source?: AgentExternalRunSource
  },
): Promise<void> {
  const sessionMeta = getAgentSessionMeta(input.sessionId)
  const parentMeta = sessionMeta?.parentSessionId
    ? getAgentSessionMeta(sessionMeta.parentSessionId)
    : undefined
  input = applyRegisteredAgentRuntimeSnapshot(
    input,
    sessionMeta?.registeredAgentSnapshot,
    parentMeta?.planModeEnabled ? 'plan' : parentMeta?.permissionMode,
  )
  // 尝试注册主窗口 webContents，让流式事件同步推送到桌面端
  const wc = getMainRendererWebContents()
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  let registrationId: number | undefined
  if (wc) {
    registrationId = registerWebContents(runInput.sessionId, wc)
  }

  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: runInput.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        callbacks.onComplete(messages)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          sendAgentStreamComplete(wc, runInput, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            // 兼容旧完成回调未携带 startedAt 的路径，保证渲染层能收敛当前运行态。
            startedAt: opts?.startedAt ?? startedAt,
            lastStopDurationMs: opts?.lastStopDurationMs,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onTranscriptSynced: (messages) => {
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.SESSION_TRANSCRIPT_SYNCED, {
            sessionId: runInput.sessionId,
            messages,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        const session = getAgentSessionMeta(runInput.sessionId)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
          },
        })
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    callbacks.onError(errorMessage)
    callbacks.onComplete()
    if (wc && !wc.isDestroyed()) {
      wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
      sendAgentStreamComplete(wc, runInput, {
        messages: [],
        stoppedByUser: false,
        startedAt,
      })
    }
  } finally {
    if (
      registrationId != null
      && !orchestrator.isActive(runInput.sessionId)
    ) {
      sessionWebContents.deleteIfCurrent(runInput.sessionId, registrationId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export async function stopAgent(sessionId: string): Promise<void> {
  await orchestrator.stop(sessionId)
}

export async function closeAgentSessionRuntime(sessionId: string): Promise<void> {
  clearAgentTurnChangeTracking(sessionId)
  await orchestrator.closeSession(sessionId)
}

/** 获取当前 Agent 本轮相对执行前基线产生的文件改动统计。 */
export async function getAgentTurnChangeStats(
  sessionId: string,
): Promise<AgentTurnChangeStats | null> {
  return readAgentTurnChangeStats(sessionId)
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)
setAgentSessionActivityProbe((sessionId) => orchestrator.isActive(sessionId))

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
  rewindFiles = false,
): Promise<import('@proma/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid, rewindFiles)
}

/** 使用当前 Local CLI 的会话能力分叉并创建 Proma 会话投影。 */
export async function forkAgentRuntimeSession(
  input: ForkSessionInput,
): Promise<AgentSessionMeta> {
  return orchestrator.forkSession(input)
}

/**
 * 清空当前会话上下文。执行中、后台任务、待审批和本地待发送队列都必须先处理，
 * 避免通过清空动作静默终止或丢弃未结工作。
 */
export async function clearAgentSession(
  input: ClearAgentSessionInput,
): Promise<ClearAgentSessionResult> {
  const pendingInteractions = [
    ...permissionService.getPendingRequests(),
    ...askUserService.getPendingRequests(),
    ...exitPlanService.getPendingRequests(),
  ].filter((request) => request.sessionId === input.sessionId).length
  const runningBackgroundTasks = backgroundTaskService.listTasks(input.sessionId)
    .filter((task) => task.status === 'running')
    .length
  const queuedMessages = Number.isFinite(input.queuedMessageCount)
    ? Math.max(0, Math.trunc(input.queuedMessageCount ?? 0))
    : 0
  const blocker = getAgentSessionClearBlocker({
    active: orchestrator.isActive(input.sessionId),
    runningBackgroundTasks,
    pendingInteractions,
    queuedMessages,
  })
  if (blocker) throw new Error(blocker)
  return orchestrator.clearSession(input.sessionId)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}

/** 退出前释放当前 Local CLI Runtime Adapter 资源。 */
export async function shutdownAgentRuntime(): Promise<void> {
  await Promise.resolve(adapter.dispose())
}

/** 运行中动态切换 Local CLI 会话的权限模式。 */
export async function updateAgentPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

/** 清除当前进程内该会话的“计划已就绪”标记。 */
export function clearAgentPlanReady(sessionId: string): void {
  orchestrator.clearPlanReady(sessionId)
}

/** 实时更新已打开的 Local CLI Session；未打开时返回 false，由下次 turn 使用持久化设置。 */
export async function updateAgentRuntimeConfig(
  sessionId: string,
  updates: {
    model?: string
    thinkingConfig?: ThinkingConfig
    effortLevel?: ThinkingEffortLevel
  },
): Promise<boolean> {
  return adapter.updateRuntimeConfig(sessionId, updates)
}

/** 模型配置变更后刷新关联的 Local CLI Session。 */
export async function invalidateAgentRuntimeConfiguration(
  channelId: string,
): Promise<void> {
  await adapter.invalidateChannelConfiguration(channelId)
}

export async function getAgentRuntimeExecutionGraph(
  sessionId: string,
): Promise<AgentRuntimeExecutionGraph> {
  await ensureLocalSessionPrepared(sessionId)
  return adapter.getExecutionGraph(sessionId)
}

export async function getAgentRuntimeSubagentTranscript(
  sessionId: string,
  executionNodeId: string,
): Promise<AgentRuntimeSubagentTranscript> {
  await ensureLocalSessionPrepared(sessionId)
  return adapter.getSubagentTranscript(sessionId, executionNodeId)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
    input.attachments,
  )
}

// ===== 文件操作 =====

/**
 * 保存文件到 Proma 私有的 Agent session 附件目录
 *
 * 文件通过绝对路径注入 Prompt，Local CLI cwd 仍保持为用户选择的真实项目目录。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionAttachmentsDir(input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 保存文件到工作区文件目录
 *
 * 将 base64 编码的文件写入工作区 workspace-files/ 目录，所有会话均可访问。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(wsFilesDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 工作区文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(wsFilesDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * CLI 原生上下文读取。
 * 默认不启动 Runtime；只有用户明确刷新详情时才允许准备会话。
 */
export async function getLocalSessionContext(
  sessionId: string,
  options: { prepareIfNeeded?: boolean } = {},
): Promise<Record<string, unknown>> {
  return readRuntimeSessionContext(
    sessionId,
    adapter,
    () => ensureLocalSessionPrepared(sessionId),
    options,
  )
}
async function ensureLocalSessionPrepared(sessionId: string): Promise<void> {
  if (!adapter.hasSession(sessionId)) {
    const input = await orchestrator.prepareSessionInput(sessionId)
    await adapter.prepareSession({ ...input, channelId: getAgentSessionMeta(sessionId)?.channelId })
  }
}
export async function getLocalSessionCatalog(sessionId: string): Promise<Record<string, unknown>> {
  await ensureLocalSessionPrepared(sessionId)
  return adapter.getCommandCatalog(sessionId)
}
export async function setLocalSessionAutoCompact(sessionId: string, enabled: boolean): Promise<Record<string, unknown>> {
  await ensureLocalSessionPrepared(sessionId)
  return applyAndPersistSessionAutoCompact(
    () => adapter.setAutoCompact(sessionId, enabled),
    () => { updateAgentSessionMeta(sessionId, { autoCompactEnabled: enabled }) },
  )
}
