import type { AppSettings } from '../../../types'

/** 这些偏好在创建 CLI 进程时固定，避免执行中切换沙箱边界。 */
export function buildDesktopCliPreferences(settings: Pick<AppSettings,
  'outputStyle' | 'localSandboxEnabled' | 'strictSandboxMode' | 'dynamicWorkflowsEnabled' | 'workType'>): {
  settings: Record<string, unknown>
  systemPrompt: string
  environment: Record<string, string>
} {
  const sandbox = settings.localSandboxEnabled === true
    ? { enabled: true, failIfUnavailable: true,
      allowUnsandboxedCommands: settings.strictSandboxMode !== true }
    : undefined
  const outputStylePrompt = settings.outputStyle === 'concise'
    ? 'Keep responses concise and direct. Preserve necessary implementation details, validation results, and unresolved issues.'
    : settings.outputStyle === 'detailed'
      ? 'Provide detailed, clearly structured explanations of implementation choices, changes, and validation. Include useful examples when they help understanding.'
      : ''
  const workType = settings.workType?.trim()
  const workTypePrompt = workType
    ? `The user describes their work as "${workType}". When relevant, adapt examples and terminology to that context without making unsupported assumptions.`
    : ''
  const systemPrompt = [outputStylePrompt, workTypePrompt].filter(Boolean).join('\n\n')
  // 未开启桌面沙箱时不覆盖项目或管理员已有的沙箱保护。
  return { settings: sandbox ? { sandbox } : {}, systemPrompt,
    environment: { CLAUDE_CODE_DYNAMIC_WORKFLOWS_ENABLED: settings.dynamicWorkflowsEnabled === true ? '1' : '0' } }
}
