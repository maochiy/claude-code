const DYNAMIC_WORKFLOWS_ENV = 'CLAUDE_CODE_DYNAMIC_WORKFLOWS_ENABLED'

/**
 * 桌面宿主可以按会话限制子 Agent 并发。纯 CLI 未注入该变量时保持原有行为。
 */
export function areDynamicWorkflowsEnabled(
  value: string | undefined = process.env[DYNAMIC_WORKFLOWS_ENV],
): boolean {
  if (value === undefined) return true
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** 禁用动态工作流时，显式覆盖调用方请求的并发数为 1。 */
export function constrainWorkflowConcurrency<
  T extends { maxConcurrency?: number },
>(input: T, dynamicWorkflowsEnabled = areDynamicWorkflowsEnabled()): T {
  return dynamicWorkflowsEnabled ? input : { ...input, maxConcurrency: 1 }
}
