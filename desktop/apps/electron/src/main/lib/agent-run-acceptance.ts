export interface AgentRunAcceptance {
  promise: Promise<void>
  accept: () => void
  reject: (error: Error) => void
}

/**
 * SEND_MESSAGE 的 IPC 只等待 Runtime 真正接收首条用户消息。
 * 后续生成继续通过流事件推进，启动前失败则直接拒绝并保留草稿。
 */
export function createAgentRunAcceptance(): AgentRunAcceptance {
  let settled = false
  let resolvePromise: () => void = () => undefined
  let rejectPromise: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return {
    promise,
    accept: () => {
      if (settled) return
      settled = true
      resolvePromise()
    },
    reject: (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    },
  }
}
