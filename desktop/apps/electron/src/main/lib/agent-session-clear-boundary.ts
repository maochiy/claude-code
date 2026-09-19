import type { AgentRuntimeClearResult } from '@proma/shared'
import type { AgentSessionClearTransaction } from './agent-session-clear-transaction'

interface RecoverableAgentSessionClearBoundaryInput<TSession> {
  intendedRuntimeSessionId: string
  clearRuntime: () => Promise<AgentRuntimeClearResult>
  closeRuntime: () => Promise<void>
  loadTransaction: () => AgentSessionClearTransaction | undefined
  finalize: (transaction: AgentSessionClearTransaction) => TSession
  rollbackPreflight: () => void
}

export interface RecoverableAgentSessionClearBoundaryResult<TSession> {
  session: TSession
  runtimeSessionId: string
  deferredRuntimeRestart: boolean
}

function isRuntimeClearRestartRequired(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'RUNTIME_CLEAR_RESTART_REQUIRED',
  )
}

function requireTransaction(
  transaction: AgentSessionClearTransaction | undefined,
): AgentSessionClearTransaction {
  if (!transaction) throw new Error('Agent 会话清空事务不存在')
  return transaction
}

/**
 * Runtime clear 与本地投影提交的故障边界。
 *
 * clearRuntime 返回后，无论 finalize 哪一步失败，都必须保留 prepared marker 与归档，
 * 由重启恢复继续提交；只有 Runtime preflight 明确拒绝时才执行回滚。
 */
export async function runRecoverableAgentSessionClearBoundary<TSession>(
  input: RecoverableAgentSessionClearBoundaryInput<TSession>,
): Promise<RecoverableAgentSessionClearBoundaryResult<TSession>> {
  let runtimeResetConfirmed = false
  try {
    const result = await input.clearRuntime()
    runtimeResetConfirmed = true
    if (result.runtimeSessionId !== input.intendedRuntimeSessionId) {
      await input.closeRuntime()
      const session = input.finalize(requireTransaction(input.loadTransaction()))
      return {
        session,
        runtimeSessionId: input.intendedRuntimeSessionId,
        deferredRuntimeRestart: true,
      }
    }
    const session = input.finalize(requireTransaction(input.loadTransaction()))
    return {
      session,
      runtimeSessionId: result.runtimeSessionId,
      deferredRuntimeRestart: false,
    }
  } catch (error) {
    if (isRuntimeClearRestartRequired(error)) {
      const session = input.finalize(requireTransaction(input.loadTransaction()))
      return {
        session,
        runtimeSessionId: input.intendedRuntimeSessionId,
        deferredRuntimeRestart: true,
      }
    }
    if (runtimeResetConfirmed) throw error
    input.rollbackPreflight()
    throw error
  }
}
