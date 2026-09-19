import type {
  AgentInteractionKind,
  AgentInteractionRequestContext,
  CreatedAgentInteractionRequestMetadata,
  AgentInteractionSettlement,
  AgentInteractionSettlementOutcome,
} from '@proma/shared'

interface SessionSequenceState {
  sequence: number
  lastCreatedAt: number
}

const sessionSequenceStates = new Map<string, SessionSequenceState>()

/** 为三个交互服务生成同一时间轴上的稳定元数据。 */
export function createInteractionRequestMetadata(
  sessionId: string,
  context?: AgentInteractionRequestContext,
): CreatedAgentInteractionRequestMetadata {
  const previous = sessionSequenceStates.get(sessionId)
  const sequence = (previous?.sequence ?? 0) + 1
  const createdAt = Math.max(previous?.lastCreatedAt ?? 0, Date.now())
  sessionSequenceStates.set(sessionId, { sequence, lastCreatedAt: createdAt })
  return {
    createdAt,
    sequence,
    toolUseId: context?.toolUseId,
    runId: context?.runId,
  }
}

interface SettleableRequest extends CreatedAgentInteractionRequestMetadata {
  requestId: string
  sessionId: string
}

/** 生成无敏感正文、可直接写入事件日志的终态记录。 */
export function createInteractionSettlement(
  request: SettleableRequest,
  kind: AgentInteractionKind,
  outcome: AgentInteractionSettlementOutcome,
  behavior?: 'allow' | 'deny',
): AgentInteractionSettlement {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    kind,
    outcome,
    behavior,
    createdAt: request.createdAt,
    settledAt: Math.max(request.createdAt, Date.now()),
    sequence: request.sequence,
    toolUseId: request.toolUseId,
    runId: request.runId,
  }
}
