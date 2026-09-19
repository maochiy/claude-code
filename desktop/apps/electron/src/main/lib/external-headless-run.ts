import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
  AgentSessionMeta,
  PromaPermissionMode,
} from '@proma/shared'
import {
  runRegisteredHeadlessAgent,
  stopRegisteredAgent,
} from './agent-headless-runner-registry'

export interface ExternalHeadlessCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
}

/**
 * 外部入口继承会话已经明确选择的权限模式。只有旧会话完全没有配置时，
 * 才使用 dontAsk，避免无人处理审批时意外提升到完全自动。
 */
export function resolveExternalPermissionMode(
  session: Pick<AgentSessionMeta, 'permissionMode' | 'planModeEnabled'> | null | undefined,
): PromaPermissionMode {
  if (session?.planModeEnabled) return 'plan'
  return session?.permissionMode ?? 'dontAsk'
}

/** 钉钉、微信、飞书共用生产 headless registry，确保来源与并发规则一致。 */
export function runExternalHeadlessAgent(
  input: AgentSendInput,
  source: Extract<AgentExternalRunSource, 'dingtalk' | 'wechat' | 'feishu'>,
  callbacks: ExternalHeadlessCallbacks,
): Promise<void> {
  return runRegisteredHeadlessAgent(input, { ...callbacks, source })
}

/** 只在底层中断 Promise 完成后返回。 */
export function stopExternalHeadlessAgent(sessionId: string): Promise<void> {
  return stopRegisteredAgent(sessionId)
}

/** callback 与 Promise rejection 共享一次错误终态。 */
export function createSingleExternalErrorSettlement(
  onError: (error: string) => void,
): (error: unknown) => boolean {
  let settled = false
  return (error) => {
    if (settled) return false
    settled = true
    onError(error instanceof Error ? error.message : String(error))
    return true
  }
}

/** 原子取出终态状态；重复 result/error 会得到 undefined。 */
export function takeExternalTerminalState<T>(
  states: Map<string, T>,
  sessionId: string,
): T | undefined {
  const state = states.get(sessionId)
  if (state !== undefined) states.delete(sessionId)
  return state
}
