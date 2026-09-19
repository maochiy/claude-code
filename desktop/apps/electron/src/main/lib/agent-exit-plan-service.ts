/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 核心职责：
 * - 拦截 ExitPlanMode 工具调用
 * - 解析 allowedPrompts，发送到渲染进程展示审批 UI
 * - 等待用户选择（批准/拒绝/反馈），返回对应 PermissionResult
 * - 根据用户选择切换权限模式
 *
 * 复用 AskUserService 的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import {
  PROMA_APPROVAL_MODES,
  type PromaApprovalMode,
  type AgentInteractionRequestContext,
  type AgentInteractionSettlement,
  type CreatedAgentInteractionRequestMetadata,
  type ExitPlanModeRequest,
  type ExitPlanModeResponse,
  type ExitPlanAllowedPrompt,
  type PromaPermissionMode,
} from '@proma/shared'
import {
  createInteractionRequestMetadata,
  createInteractionSettlement,
} from './agent-interaction-lifecycle'

/** ExitPlanMode 审批结果（扩展 SDK PermissionResult，附加 targetMode） */
export type ExitPlanPermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
  /** 用户选择的目标权限模式 */
  targetMode?: PromaPermissionMode
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 ExitPlanMode 请求 */
interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => void
  request: ExitPlanModeRequest & CreatedAgentInteractionRequestMetadata
  toolInput: Record<string, unknown>
  signal: AbortSignal
  abortListener: () => void
  onSettled?: (settlement: AgentInteractionSettlement) => void
}

export interface ExitPlanLifecycleCallbacks {
  requestContext?: AgentInteractionRequestContext
  onPending?: (request: ExitPlanModeRequest) => void
  onSettled?: (settlement: AgentInteractionSettlement) => void
}

/** ExitPlanMode 审批结果回调（通知编排层切换权限模式） */
export interface ExitPlanModeCallbacks {
  /** 切换权限模式 */
  onPermissionModeChange: (mode: PromaPermissionMode) => void
}

/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 单例模式，管理所有会话的 ExitPlanMode 请求。
 */
export class AgentExitPlanService {
  /** 待处理的请求 Map（requestId → PendingExitPlan） */
  private pendingRequests = new Map<string, PendingExitPlan>()

  /**
   * 处理 ExitPlanMode 工具调用
   *
   * 解析 allowedPrompts，发送到渲染进程，阻塞等待用户选择。
   */
  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void,
    lifecycle?: ExitPlanLifecycleCallbacks,
  ): Promise<ExitPlanPermissionResult> {
    if (signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: '操作已中止' })
    }
    const allowedPrompts = this.parseAllowedPrompts(input)

    const request: ExitPlanModeRequest & CreatedAgentInteractionRequestMetadata = {
      requestId: randomUUID(),
      sessionId,
      ...createInteractionRequestMetadata(sessionId, lifecycle?.requestContext),
      toolInput: input,
      allowedPrompts,
    }

    return new Promise<ExitPlanPermissionResult>((resolve) => {
      const abortListener = (): void => {
        this.settleRequest(
          request.requestId,
          { behavior: 'deny', message: '操作已中止' },
          'aborted',
        )
      }
      this.pendingRequests.set(request.requestId, {
        resolve,
        request,
        toolInput: input,
        signal,
        abortListener,
        onSettled: lifecycle?.onSettled,
      })
      signal.addEventListener('abort', abortListener, { once: true })
      try {
        lifecycle?.onPending?.(request)
        sendToRenderer(request)
      } catch {
        this.settleRequest(
          request.requestId,
          { behavior: 'deny', message: '无法发起计划确认' },
          'delivery_failed',
        )
      }
    })
  }

  private settleRequest(
    requestId: string,
    result: ExitPlanPermissionResult,
    outcome: AgentInteractionSettlement['outcome'],
  ): { sessionId: string; targetMode: PromaPermissionMode | null } | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    this.pendingRequests.delete(requestId)
    pending.signal.removeEventListener('abort', pending.abortListener)
    const targetMode = result.behavior === 'allow' ? result.targetMode ?? null : null
    try {
      pending.onSettled?.(createInteractionSettlement(
        pending.request,
        'exit_plan',
        outcome,
        result.behavior,
      ))
    } catch {
      console.warn('[Agent 计划审批] 同步请求终态失败，请求仍正常结束。')
    } finally {
      pending.resolve(result)
    }
    return { sessionId: pending.request.sessionId, targetMode }
  }

  /**
   * 响应 ExitPlanMode 请求（由 IPC handler 调用）
   *
   * @returns { sessionId, targetMode } 用于通知编排层；未找到返回 null
   */
  respondToExitPlanMode(response: ExitPlanModeResponse): { sessionId: string; targetMode: PromaPermissionMode | null } | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null

    switch (response.action) {
      case 'approve': {
        if (!isApprovalMode(response.approvalMode)) {
          throw new Error('批准计划时必须提供有效的目标审批模式')
        }
        return this.settleRequest(response.requestId, {
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: response.approvalMode,
        }, 'approved')
      }
      case 'approve_bypass': {
        // 旧 Renderer 兼容：批准并切换到完全自动模式。
        return this.settleRequest(response.requestId, {
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'bypassPermissions',
        }, 'approved')
      }
      case 'deny': {
        // 拒绝计划
        return this.settleRequest(response.requestId, {
          behavior: 'deny' as const,
          message: '用户拒绝了计划',
        }, 'denied')
      }
      case 'feedback': {
        const feedback = response.feedback?.trim()
        if (!feedback) {
          throw new Error('计划修改意见不能为空')
        }
        // 用户提供反馈，拒绝并附带反馈内容
        return this.settleRequest(response.requestId, {
          behavior: 'deny' as const,
          message: feedback,
        }, 'feedback')
      }
      default: {
        throw new Error('计划审批操作无效')
      }
    }
  }

  /**
   * 获取当前所有待处理的 ExitPlanMode 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()]
      .map((p) => p.request)
      .sort(compareInteractionRequests)
  }

  /**
   * 清除指定会话的所有待处理请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        this.settleRequest(
          requestId,
          { behavior: 'deny', message: '会话已结束' },
          'cancelled',
        )
      }
    }
  }

  /**
   * 从工具输入中解析 allowedPrompts
   */
  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    const raw = input.allowedPrompts
    if (!Array.isArray(raw)) return []

    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item): ExitPlanAllowedPrompt => ({
        tool: typeof item.tool === 'string' ? item.tool as 'Bash' : 'Bash',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      }))
      .filter((item) => item.prompt.length > 0)
  }
}

function isApprovalMode(value: unknown): value is PromaApprovalMode {
  return typeof value === 'string'
    && (PROMA_APPROVAL_MODES as readonly string[]).includes(value)
}

function compareInteractionRequests(a: ExitPlanModeRequest, b: ExitPlanModeRequest): number {
  if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence
  if (a.createdAt !== undefined && b.createdAt !== undefined) return a.createdAt - b.createdAt
  return 0
}

/** 全局 ExitPlanMode 服务实例 */
export const exitPlanService = new AgentExitPlanService()
