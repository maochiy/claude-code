import type { SDKMessage } from '@proma/shared'

/** 原生 UUID 优先；无 UUID 的状态事件使用服务代次和序号，避免空串合并全部状态。 */
export function localCliMessageIdentity(message: SDKMessage): string | undefined {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid) return `uuid:${record.uuid}`
  if (typeof record._runtimeGeneration === 'number' && typeof record._runtimeSequence === 'number') {
    return `event:${record._runtimeGeneration}:${record._runtimeSequence}`
  }
  return undefined
}
