interface OutputSnapshot {
  cursor: number
  content: string
}

type ReadChunk = (cursor: number, byteLimit: number) => Promise<Record<string, unknown>>

/** 每个原生进程独立缓存游标；轮询只读取新字节，同时保留面板需要的完整文本。 */
export class TaskOutputReader {
  private readonly snapshots = new Map<string, OutputSnapshot>()
  private readonly pending = new Map<string, Promise<string>>()

  read(taskId: string, readChunk: ReadChunk): Promise<string> {
    const previous = this.pending.get(taskId)
    if (previous) return previous
    const pending = this.readSnapshot(taskId, readChunk).finally(() => this.pending.delete(taskId))
    this.pending.set(taskId, pending)
    return pending
  }

  private async readSnapshot(taskId: string, readChunk: ReadChunk): Promise<string> {
    let snapshot = this.snapshots.get(taskId) ?? { cursor: 0, content: '' }
    let end: number | undefined
    let restarted = false
    for (;;) {
      const result = await readChunk(snapshot.cursor, end === undefined ? 65536 : Math.max(4, Math.min(65536, end - snapshot.cursor)))
      if (result.task_id !== taskId || typeof result.content !== 'string' || typeof result.eof !== 'boolean'
        || !Number.isSafeInteger(result.next_cursor) || !Number.isSafeInteger(result.total_bytes)) {
        throw new Error('CLI 返回了无效的后台任务输出')
      }
      const next = result.next_cursor as number
      const total = result.total_bytes as number
      if (next < 0 || total < 0 || next > total) throw new Error('后台任务输出偏移无效')
      if (total < snapshot.cursor) {
        if (restarted) throw new Error('后台任务日志读取期间反复截断')
        snapshot = { cursor: 0, content: '' }
        end = undefined
        restarted = true
        continue
      }
      end ??= total
      if (next < snapshot.cursor || (next === snapshot.cursor && !result.eof && next < end)) {
        throw new Error('后台任务输出偏移未向前推进')
      }
      snapshot = { cursor: next, content: snapshot.content + result.content }
      this.snapshots.set(taskId, snapshot)
      // 固定首次读取的结尾；持续写日志也不会让一次读取永远无法完成。
      if (result.eof || next >= end) return snapshot.content
    }
  }
}
