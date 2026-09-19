import type { RuntimeId } from '@proma/shared'

export interface AgentSessionClearState {
  active: boolean
  runningBackgroundTasks: number
  pendingInteractions: number
  queuedMessages: number
}

interface AgentSessionRuntimeIdentity {
  runtimeId?: RuntimeId
  runtimeSessionId?: string
  pendingFreshNativeSessionId?: string
}

export interface AgentSessionRuntimeStart {
  nativeSessionId?: string
  resumeSessionId?: string
}

/**
 * 清空后首次启动使用预留 native ID，但不传 resume；收到首条原生回复后才恢复常规 resume。
 */
export function resolveAgentSessionRuntimeStart(
  session: AgentSessionRuntimeIdentity | undefined,
  runtimeId: RuntimeId,
): AgentSessionRuntimeStart {
  if (!session || session.runtimeId !== runtimeId) return {}
  if (session.pendingFreshNativeSessionId) {
    return { nativeSessionId: session.pendingFreshNativeSessionId }
  }
  return session.runtimeSessionId
    ? { resumeSessionId: session.runtimeSessionId }
    : {}
}

/** 清空会话前统一检查，任何未结工作都必须由用户先显式处理。 */
export function getAgentSessionClearBlocker(
  state: AgentSessionClearState,
): string | null {
  if (state.active) return '会话仍在执行中，请先停止并等待结束后再清空'
  if (state.runningBackgroundTasks > 0) {
    return `会话仍有 ${state.runningBackgroundTasks} 个后台任务，请先等待或停止任务后再清空`
  }
  if (state.pendingInteractions > 0) {
    return `会话仍有 ${state.pendingInteractions} 个待处理请求，请先完成或拒绝后再清空`
  }
  if (state.queuedMessages > 0) {
    return `会话仍有 ${state.queuedMessages} 条待发送消息，请先发送或移除后再清空`
  }
  return null
}
