import type { SDKAssistantMessage, SDKMessage, SDKSystemMessage } from '@proma/shared'
import { isPersistableSDKSystemMessage } from '@proma/shared'

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** 判断本轮 SDK 消息中是否包含用户最终能看到的内容。 */
export function isVisibleRunMessage(message: SDKMessage): boolean {
  const msgRecord = message as Record<string, unknown>
  if (msgRecord.isReplay) return false

  if (message.type === 'assistant') {
    const assistantMsg = message as SDKAssistantMessage
    if (assistantMsg.error) return true
    const content = assistantMsg.message?.content
    if (!Array.isArray(content)) return false
    return content.some((block) => {
      if (block.type === 'text') return isNonEmptyString((block as { text?: unknown }).text)
      if (block.type === 'thinking') return isNonEmptyString((block as { thinking?: unknown }).thinking)
      if (block.type === 'tool_use') return true
      return Object.keys(block).length > 1
    })
  }

  if (message.type === 'user') {
    const content = (message as { message?: { content?: Array<{ type: string }> } }).message?.content
    return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
  }

  if (message.type === 'system') {
    const systemMessage = message as SDKSystemMessage
    return isPersistableSDKSystemMessage(systemMessage)
      || systemMessage.subtype === 'task_started'
      || systemMessage.subtype === 'task_progress'
      || systemMessage.subtype === 'task_notification'
  }

  return false
}

/**
 * 流式 assistant 只有正文或工具活动可作为“本轮已有输出”的证据。
 * thinking partial 在最终正文出现前会隐藏，不能单独压掉空回复保护。
 */
export function isVisiblePartialRunMessage(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false
  const content = (message as SDKAssistantMessage).message?.content
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (block.type === 'text') return isNonEmptyString((block as { text?: unknown }).text)
    return block.type === 'tool_use'
  })
}
