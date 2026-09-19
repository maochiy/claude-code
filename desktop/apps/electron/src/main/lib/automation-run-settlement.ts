export interface AutomationExecutionCallbacks {
  onComplete(): void
  onError(error: string): void
}

export interface AutomationExecutionOutcome {
  status: 'success' | 'error'
  error?: string
  timedOut: boolean
  stopSucceeded?: boolean
  stopError?: string
}

export interface AwaitAutomationExecutionInput {
  sessionId: string
  timeoutMs: number
  timeoutMessage: string
  start(callbacks: AutomationExecutionCallbacks): Promise<void>
  stopAgent(sessionId: string): Promise<void>
}

/**
 * 等待一次自动任务执行结束。
 *
 * 首个完成、错误或超时事件独占结算权。超时取得结算权后必须先等待真实停止，
 * 避免记录已结束但底层 Agent 仍继续运行；停止期间到达的完成事件不会重复结算。
 */
export function awaitAutomationExecution(
  input: AwaitAutomationExecutionInput,
): Promise<AutomationExecutionOutcome> {
  return new Promise((resolve) => {
    let claimed = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const claim = (): boolean => {
      if (claimed) return false
      claimed = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      return true
    }

    const settle = (outcome: AutomationExecutionOutcome): void => {
      if (!claim()) return
      resolve(outcome)
    }

    timeoutTimer = setTimeout(() => {
      if (!claim()) return
      void input.stopAgent(input.sessionId)
        .then(() => {
          resolve({
            status: 'error',
            error: input.timeoutMessage,
            timedOut: true,
            stopSucceeded: true,
          })
        })
        .catch((error: unknown) => {
          const stopError = error instanceof Error ? error.message : String(error)
          resolve({
            status: 'error',
            error: `${input.timeoutMessage}；停止 Agent 失败：${stopError}`,
            timedOut: true,
            stopSucceeded: false,
            stopError,
          })
        })
    }, input.timeoutMs)

    try {
      void input.start({
        onComplete: () => settle({ status: 'success', timedOut: false }),
        onError: error => settle({ status: 'error', error, timedOut: false }),
      }).catch((error: unknown) => {
        settle({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
        })
      })
    } catch (error) {
      settle({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
      })
    }
  })
}
