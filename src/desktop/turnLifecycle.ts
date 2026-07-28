import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

/** CCB SDK result 是 Desktop Runtime 当前 Turn 的明确终止边界。 */
export function isTerminalTurnMessage(message: SDKMessage): boolean {
  return message.type === 'result'
}

/**
 * 等待下一条 QueryEngine 消息，同时监听当前 AbortSignal。
 *
 * CCB CLI/Bridge 在取消时不会继续等待慢 API、MCP 或后台工具的 iterator.next()
 * 自然返回；Desktop 也必须采用同样语义，才能让 Stop 达到毫秒级响应。
 */
export function nextTurnMessageOrAbort<T>(
  iterator: AsyncIterator<T>,
  abortSignal: AbortSignal,
): Promise<IteratorResult<T, void>> {
  if (abortSignal.aborted) {
    return Promise.resolve({ done: true, value: undefined })
  }

  let abortHandler: (() => void) | undefined
  const aborted = new Promise<IteratorResult<T, void>>(resolve => {
    abortHandler = () => resolve({ done: true, value: undefined })
    abortSignal.addEventListener('abort', abortHandler, { once: true })
  })

  return Promise.race([iterator.next(), aborted]).finally(() => {
    if (abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler)
    }
  })
}

/**
 * 协调 turn.stop 与实际 QueryEngine 退出。
 *
 * Stop 命令可以等待当前 Turn 真正变为空闲；运行循环在 finally 中统一 resolve。
 */
export class TurnIdleBarrier {
  private readonly waiters = new Set<() => void>()

  wait(isRunning: boolean): Promise<void> {
    if (!isRunning) return Promise.resolve()
    return new Promise(resolve => this.waiters.add(resolve))
  }

  resolve(): void {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }
}
