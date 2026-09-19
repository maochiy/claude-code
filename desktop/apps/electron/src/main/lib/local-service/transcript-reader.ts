import type { SDKMessage } from '@proma/shared'

/** 分页只能属于同一原生快照；恢复过程中不调用发送、工具或审批接口。 */
export async function readNativeTranscript(
  fetchPage: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  let cursor = 0
  let snapshotId: string | undefined
  let total: number | undefined
  do {
    const page = await fetchPage({ cursor, limit: 256, ...(snapshotId ? { snapshot_id: snapshotId } : {}) })
    if (typeof page.snapshot_id !== 'string' || !page.snapshot_id
      || (snapshotId !== undefined && snapshotId !== page.snapshot_id)
      || !Number.isSafeInteger(page.total) || Number(page.total) < 0
      || (total !== undefined && total !== page.total)
      || page.cursor !== cursor || !Number.isSafeInteger(page.next_cursor)
      || !Array.isArray(page.messages) || typeof page.eof !== 'boolean'
      || page.truncated !== false) throw new Error('CLI 历史快照不完整或分页不一致')
    total = Number(page.total)
    snapshotId = page.snapshot_id
    const next = Number(page.next_cursor)
    if (next !== cursor + page.messages.length || next > total
      || page.eof !== (next === total) || (!page.eof && next <= cursor)) {
      throw new Error('CLI 历史快照游标未正确前进')
    }
    for (const value of page.messages) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI 历史消息格式无效')
      const message = value as Record<string, unknown>
      if (!['user', 'assistant', 'system'].includes(String(message.type))
        || typeof message.uuid !== 'string' || !message.uuid) throw new Error('CLI 历史消息缺少原生身份')
      messages.push({ ...message, type: String(message.type), _promaNativeMessage: true } as SDKMessage)
    }
    cursor = next
    if (page.eof) return messages
  } while (true)
}
