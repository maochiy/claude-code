/** 同一会话的打开和配置更新串行执行；失败不会阻塞下一次恢复。 */
export class SessionPreparationGate {
  private readonly pending = new Map<string, Promise<unknown>>()

  async run<T>(sessionId: string, prepare: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId)
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(prepare)
    this.pending.set(sessionId, current)
    try {
      return await current
    } finally {
      if (this.pending.get(sessionId) === current) this.pending.delete(sessionId)
    }
  }
}
