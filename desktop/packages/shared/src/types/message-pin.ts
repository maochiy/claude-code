/** 消息置顶持久化 IPC。 */
export const MESSAGE_PIN_IPC_CHANNELS = {
  LIST: 'agent-message-pin:list',
  SET: 'agent-message-pin:set',
} as const

/** 单个会话的消息置顶快照。 */
export interface AgentMessagePinsSnapshot {
  sessionId: string
  /** 按置顶顺序保存的原生消息 UUID。 */
  messageUuids: string[]
  /** 历史已不存在、无法跳转的旧 UUID；调用方应明确提示而不是静默跳错位置。 */
  missingMessageUuids: string[]
}

/** 将消息置顶状态设置为期望值；重复调用保持幂等。 */
export interface AgentMessagePinUpdateInput {
  sessionId: string
  messageUuid: string
  pinned: boolean
}
