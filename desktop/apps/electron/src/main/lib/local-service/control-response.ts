import type { LocalServiceEvent } from './client'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export interface LocalCliControlResolution {
  requestId: string
  result?: Record<string, unknown>
  error?: Error
}

/** 解包 Local Service 的异步 control_resolved 事件，拒绝不完整的伪响应。 */
export function parseLocalCliControlResolution(
  event: LocalServiceEvent,
): LocalCliControlResolution | undefined {
  if (event.kind !== 'control_resolved' || !event.requestId) return undefined
  const envelope = record(event.payload.response)
  if (envelope.subtype === 'error') {
    const error = record(envelope.error)
    return {
      requestId: event.requestId,
      error: new Error(
        typeof envelope.error === 'string'
          ? envelope.error
          : typeof error.message === 'string'
            ? error.message
            : 'CLI 控制请求失败',
      ),
    }
  }
  if (envelope.subtype !== 'success') {
    return { requestId: event.requestId, error: new Error('CLI 返回了无效的控制响应') }
  }
  return { requestId: event.requestId, result: record(envelope.response) }
}
