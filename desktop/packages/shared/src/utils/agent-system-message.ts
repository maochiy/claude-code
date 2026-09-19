import type { SDKSystemMessage } from '../types/agent'

export type SDKCompactStatus = 'compacting' | 'success' | 'failed' | 'noop' | 'stopped'

export function getSDKCompactStatus(message: SDKSystemMessage): SDKCompactStatus | undefined {
  if (message.subtype === 'compact_boundary') return 'success'
  if (message.subtype === 'compacting') return 'compacting'

  if (message.subtype !== 'status') return undefined
  if (message.compact_result === 'success' || message.compact_result === 'failed'
    || message.compact_result === 'noop' || message.compact_result === 'stopped') {
    return message.compact_result
  }
  if (message.status === 'compacting') return 'compacting'
  if (typeof message.compact_error === 'string' && message.compact_error.trim().length > 0) {
    return 'failed'
  }
  return undefined
}

export function isPersistableSDKSystemMessage(message: SDKSystemMessage): boolean {
  return message.subtype === 'interaction_settled'
    || message.subtype === 'auto_mode_classifier'
    || message.subtype === 'hook_started'
    || message.subtype === 'hook_progress'
    || message.subtype === 'hook_response'
    || message.subtype === 'task_started'
    || message.subtype === 'task_progress'
    || message.subtype === 'task_notification'
    || message.subtype === 'permission_denied'
    || message.subtype === 'context_compaction_config'
    || getSDKCompactStatus(message) != null
}
