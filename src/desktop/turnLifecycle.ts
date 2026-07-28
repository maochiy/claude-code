import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

/** CCB SDK result 是 Desktop Runtime 当前 Turn 的明确终止边界。 */
export function isTerminalTurnMessage(message: SDKMessage): boolean {
  return message.type === 'result'
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
