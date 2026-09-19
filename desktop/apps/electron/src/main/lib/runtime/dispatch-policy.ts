/**
 * Proma Runtime Dispatch Policy。
 *
 * 这是 Hermes 调度器使用的纯策略层：只负责识别意图和生成候选任务，
 * 不持久化状态、不启动 Runtime，也不把任务暴露成固定 Workflow UI。
 */

import type { AgentDispatchContext, AgentWorkflowStage, RuntimeId, RuntimeTaskKind } from '@proma/shared'
import { EXECUTABLE_RUNTIME_ID } from './executable-runtime-policy'

export type DispatchIntent =
  | 'general_execution'
  | 'requirements_clarification'
  | 'task_decomposition_coordination'
  | 'complete_plan_generation'
  | 'approved_plan_implementation'
  | 'code_implementation_review'
  | 'code_review'
  | 'complex_reasoning'
  | 'work_coordination'

export interface DispatchTaskBlueprint {
  kind: RuntimeTaskKind
  runtimeId: RuntimeId
  title: string
  dependsOn: number[]
  requiresUserApproval: boolean
  maxRetries?: number
}

export interface DispatchInput {
  message?: string
  prompt?: string
  title?: string
  taskId?: string
  taskDispatch?: boolean
  executionMode?: string
  collaborationMode?: string
  userAgentCount?: number
  planStage?: string
  planRequested?: boolean
  approvedPlan?: boolean
  planExecutionId?: string
  internalSubRun?: boolean
  forcedRuntimeId?: RuntimeId
  runtimeId?: string
  /** 已由主进程验证的当前任务类型。 */
  internalTaskKind?: RuntimeTaskKind
  /** 已由用户确认需求；Renderer 不能单独设置。 */
  requirementsConfirmed?: boolean
  /** 最近一次 Pi 澄清尚未收到用户确认，继续由 Pi 处理。 */
  clarificationPending?: boolean
  /** 已由主进程验证的批准任务。 */
  approvedTaskIds?: string[]
  /** 仅由主进程内部调度入口使用。 */
  internalDispatch?: boolean
  /** 旧 Workflow IPC 的兼容字段；新请求不会设置。 */
  internalWorkflowStage?: AgentWorkflowStage
}

export interface DispatchDecision {
  intent: DispatchIntent
  runtimeId: RuntimeId
  chain: RuntimeId[]
  dispatchReason: string
  ignoredExplicitRuntime: boolean
  requiresRequirementsConfirmation: boolean
  requiresPlanApproval: boolean
  strategyId: string
  taskBlueprint: DispatchTaskBlueprint[]
  systemPrompt: string
}

/**
 * 清理来自 Renderer 的调度上下文。
 *
 * 需求确认、计划批准、任务类型、Runtime 和 Dispatch Run 都必须由主进程
 * 根据持久化任务图补全；这里永远不透传这些内部字段。
 */
export function sanitizeDispatchContext(
  input: AgentDispatchContext | undefined,
): Pick<AgentDispatchContext, 'taskId' | 'taskDispatch' | 'executionMode' | 'collaborationMode' | 'userAgentCount' | 'planStage' | 'planRequested'> {
  if (!input) return {}
  return {
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    taskDispatch: input.taskDispatch === true,
    executionMode: typeof input.executionMode === 'string' ? input.executionMode : undefined,
    collaborationMode: typeof input.collaborationMode === 'string' ? input.collaborationMode : undefined,
    userAgentCount: typeof input.userAgentCount === 'number' ? input.userAgentCount : undefined,
    planStage: input.planStage,
    planRequested: input.planRequested === true,
  }
}

/** 执行和计划由 CLI 原生循环决定，不按提示词关键词再造一套工作流。 */
export function dispatchForRequest(input: DispatchInput = {}): DispatchDecision {
  return {
    intent: input.planRequested ? 'complete_plan_generation' : 'general_execution',
    runtimeId: EXECUTABLE_RUNTIME_ID,
    chain: [],
    dispatchReason: 'local_cli_native_execution',
    ignoredExplicitRuntime: Boolean(input.runtimeId && input.runtimeId !== EXECUTABLE_RUNTIME_ID),
    requiresRequirementsConfirmation: false,
    requiresPlanApproval: false,
    strategyId: 'desktop.local-cli.v1',
    taskBlueprint: [{ kind: 'conversation', runtimeId: EXECUTABLE_RUNTIME_ID,
      title: '执行当前会话', dependsOn: [], requiresUserApproval: false }],
    systemPrompt: '',
  }
}
export function builtInSystemPrompt(_runtimeId: RuntimeId, _intent: DispatchIntent): string {
  return ''
}
