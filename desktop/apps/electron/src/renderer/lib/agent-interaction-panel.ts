export type AgentInteractionPanelKind = 'permission' | 'askUser' | 'exitPlan'

interface AgentInteractionRequestIdentity {
  requestId: string
  createdAt?: number
  sequence?: number
}

export interface AgentInteractionRequestQueues {
  permission: readonly AgentInteractionRequestIdentity[]
  askUser: readonly AgentInteractionRequestIdentity[]
  exitPlan: readonly AgentInteractionRequestIdentity[]
}

export interface ActiveAgentInteractionRequest {
  kind: AgentInteractionPanelKind
  requestId: string
}

interface RankedAgentInteractionRequest extends ActiveAgentInteractionRequest {
  createdAt?: number
  sequence?: number
  fallbackOrder: number
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从三类请求队列中选择真正最早进入队列的一项。
 *
 * 两项都具备主进程单调递增的 sequence 时按序号比较；混有旧请求时，
 * 回退到 createdAt 与原有的权限 → AskUser → 计划顺序，保证历史数据可用。
 */
export function getActiveAgentInteractionRequest(
  queues: AgentInteractionRequestQueues,
): ActiveAgentInteractionRequest | null {
  const ranked: RankedAgentInteractionRequest[] = []
  const append = (
    kind: AgentInteractionPanelKind,
    requests: readonly AgentInteractionRequestIdentity[],
    kindOrder: number,
  ): void => {
    requests.forEach((request, index) => ranked.push({
      kind,
      requestId: request.requestId,
      sequence: finiteNumber(request.sequence),
      createdAt: finiteNumber(request.createdAt),
      fallbackOrder: kindOrder * 1_000_000 + index,
    }))
  }

  append('permission', queues.permission, 0)
  append('askUser', queues.askUser, 1)
  append('exitPlan', queues.exitPlan, 2)

  ranked.sort((left, right) => {
    if (left.sequence != null && right.sequence != null) {
      if (left.sequence !== right.sequence) return left.sequence - right.sequence
    }
    if (left.createdAt != null || right.createdAt != null) {
      if (left.createdAt == null) return 1
      if (right.createdAt == null) return -1
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    }
    if (left.sequence != null || right.sequence != null) {
      if (left.sequence == null) return 1
      if (right.sequence == null) return -1
    }
    return left.fallbackOrder - right.fallbackOrder
  })

  const active = ranked[0]
  return active ? { kind: active.kind, requestId: active.requestId } : null
}
