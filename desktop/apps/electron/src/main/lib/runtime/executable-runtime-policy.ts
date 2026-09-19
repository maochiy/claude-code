import type { RuntimeId } from '@proma/shared'

/** 历史 Pi 标识仅用于读取；新执行统一使用自有 CLI。 */
export const EXECUTABLE_RUNTIME_ID = 'local-cli' as const

export function normalizeExecutableRuntimeId(_runtimeId: RuntimeId | string | null | undefined): typeof EXECUTABLE_RUNTIME_ID {
  return EXECUTABLE_RUNTIME_ID
}
export function isExecutableRuntimeId(runtimeId: unknown): runtimeId is typeof EXECUTABLE_RUNTIME_ID {
  return runtimeId === EXECUTABLE_RUNTIME_ID
}
