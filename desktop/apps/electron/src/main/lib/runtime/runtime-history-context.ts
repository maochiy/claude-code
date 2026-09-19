import type { SDKMessage, SDKUserMessage } from '@proma/shared'
import { groupIntoTurns, isUserInputMessage, toTranscript } from '@proma/session-core'

export interface RuntimeRetryHistoryResolution {
  historyMessages: Array<{ role: string; content: string }>
  /** 只有精确找到错误和它之前的用户回合时，才可复用已持久化的 user。 */
  reusePersistedUser: boolean
  status: 'matched' | 'error_not_found' | 'user_not_found'
}

/** 从统一历史投影读取最近对话，不依赖旧扁平消息的 role 字段。 */
export function buildRuntimeHistoryMessages(messages: SDKMessage[]): Array<{ role: string; content: string }> {
  return toTranscript(groupIntoTurns(messages))
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
    .slice(-24)
    .map((turn) => ({
      role: turn.role,
      content: [turn.text, ...turn.toolSummaries].filter(Boolean).join('\n'),
    }))
    .filter((message) => message.content.length > 0)
}

/**
 * 用错误 UUID 精确解析重试边界。
 *
 * 不能按正文匹配：用户可能多次发送相同内容，富文本和附件的投影也可能改变正文。
 * 仅当错误及其之前最近的真实 user 都存在时，调用方才可复用已持久化的 user。
 */
export function buildRuntimeRetryHistoryMessages(
  messages: SDKMessage[],
  retryOfErrorUuid: string,
): RuntimeRetryHistoryResolution {
  const errorIndex = messages.findIndex((message) =>
    message.type === 'assistant'
      && (message as { uuid?: string }).uuid === retryOfErrorUuid
      && Boolean((message as { error?: unknown }).error),
  )
  if (errorIndex < 0) {
    return {
      historyMessages: buildRuntimeHistoryMessages(messages),
      reusePersistedUser: false,
      status: 'error_not_found',
    }
  }

  let userIndex = -1
  for (let index = errorIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && isUserInputMessage(message as SDKUserMessage)) {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) {
    return {
      historyMessages: buildRuntimeHistoryMessages(messages),
      reusePersistedUser: false,
      status: 'user_not_found',
    }
  }

  return {
    historyMessages: buildRuntimeHistoryMessages(messages.slice(0, userIndex)),
    reusePersistedUser: true,
    status: 'matched',
  }
}
