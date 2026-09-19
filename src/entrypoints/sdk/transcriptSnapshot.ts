import { randomUUID } from 'node:crypto'
import type { SDKMessage } from './coreTypes.js'

export interface TranscriptPageRequest {
  snapshot_id?: string
  cursor?: number
  limit?: number
}

/** 单个 CLI 会话的只读快照；分页过程中不混入新消息或执行任何历史操作。 */
export class TranscriptSnapshot {
  private current?: { id: string; messages: SDKMessage[] }

  read(request: TranscriptPageRequest, capture: () => SDKMessage[]) {
    const cursor = request.cursor ?? 0
    const limit = request.limit ?? 256
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new Error('Invalid transcript cursor or limit')
    }
    if (!request.snapshot_id) {
      if (cursor !== 0)
        throw new Error('A transcript snapshot ID is required for continuation')
      this.current = { id: randomUUID(), messages: structuredClone(capture()) }
    }
    const snapshot = this.current
    if (
      !snapshot ||
      (request.snapshot_id && request.snapshot_id !== snapshot.id)
    ) {
      throw new Error('Transcript snapshot expired; start a new snapshot')
    }
    if (cursor > snapshot.messages.length)
      throw new Error('Transcript cursor is out of range')
    const nextCursor = Math.min(cursor + limit, snapshot.messages.length)
    return {
      snapshot_id: snapshot.id,
      messages: snapshot.messages.slice(cursor, nextCursor),
      cursor,
      next_cursor: nextCursor,
      total: snapshot.messages.length,
      eof: nextCursor === snapshot.messages.length,
      truncated: false,
    }
  }
}
