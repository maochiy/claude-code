export interface SessionContextRuntime {
  hasSession: (sessionId: string) => boolean
  getContextUsage: (sessionId: string) => Promise<Record<string, unknown>>
}

export interface ReadSessionContextOptions {
  prepareIfNeeded?: boolean
}

/**
 * 读取 Runtime 上下文时强制区分只读查看和用户主动刷新。
 * 默认路径绝不准备会话，防止浏览历史记录时启动 CLI。
 */
export async function readRuntimeSessionContext(
  sessionId: string,
  runtime: SessionContextRuntime,
  prepareSession: () => Promise<void>,
  options: ReadSessionContextOptions = {},
): Promise<Record<string, unknown>> {
  if (!runtime.hasSession(sessionId)) {
    if (!options.prepareIfNeeded) {
      throw new Error('该会话尚未连接 Runtime，请打开上下文详情后主动刷新。')
    }
    await prepareSession()
  }
  return runtime.getContextUsage(sessionId)
}
