import type { SDKMessage } from '@proma/shared'
import { localCliMessageIdentity } from './message-identity'

export interface HistoryReconciliation {
  messages: SDKMessage[]
  added: number
}

/**
 * 只补齐原生历史中有稳定 UUID 的缺失消息，不重放工具、统计或审批。
 * 桌面独有事件保留原位；原生公共锚点顺序冲突时停止，避免默默重排历史。
 */
export function reconcileNativeHistory(
  existing: SDKMessage[],
  nativeMessages: SDKMessage[],
): HistoryReconciliation {
  const positions = new Map<string, number>()
  existing.forEach((message, index) => {
    const identity = localCliMessageIdentity(message)
    if (identity && !positions.has(identity)) positions.set(identity, index)
  })
  const seen = new Set<string>()
  const output: SDKMessage[] = []
  let existingCursor = 0
  let previousAnchor = -1
  let added = 0
  let pending: SDKMessage[] = []
  for (const message of nativeMessages) {
    const identity = localCliMessageIdentity(message)
    // 事件序号只在服务日志内有效，不能用来跨原生 transcript 关联。
    if (!identity?.startsWith('uuid:')) throw new Error('原生历史消息缺少稳定 UUID，无法安全恢复')
    if (seen.has(identity)) continue
    seen.add(identity)
    const anchor = positions.get(identity)
    if (anchor === undefined) {
      pending.push({ ...message, _promaNativeMessage: true } as SDKMessage)
      added += 1
      continue
    }
    if (anchor <= previousAnchor) throw new Error('原生历史与桌面消息顺序冲突，已保留现有历史')
    output.push(...existing.slice(existingCursor, anchor), ...pending, existing[anchor]!)
    pending = []
    existingCursor = anchor + 1
    previousAnchor = anchor
  }
  output.push(...existing.slice(existingCursor), ...pending)
  return { messages: added ? output : existing, added }
}
