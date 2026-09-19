import type { PermissionDenyDecision } from './PermissionResult.js'
import { getToolNameForPermissionCheck } from '../../services/mcp/mcpStringUtils.js'
/** 桌面宿主指定的工具范围只会收窄原生权限，不产生批准。 */
export interface HostToolPolicyDecision {
  allowed: boolean
  reason?: 'invalid_policy' | 'not_allowed'
}

const builtins = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'PowerShell',
  'Glob',
  'Grep',
  'Agent',
  'Skill',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'Workflow',
  'LSP',
]
const canonicalNames = new Map(builtins.map(name => [name.toLowerCase(), name]))
const normalize = (name: string): string =>
  canonicalNames.get(name.toLowerCase()) ?? name

function validNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      name =>
        typeof name === 'string' && name.length > 0 && !/[()\s]/.test(name),
    )
  )
}

function matches(pattern: string, tool: string): boolean {
  const escaped = normalize(pattern)
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(normalize(tool))
}

export function evaluateHostToolPolicy(
  toolName: string,
  serialized: string | undefined = process.env.XCODES_TOOL_POLICY_JSON,
): HostToolPolicyDecision {
  if (serialized === undefined) return { allowed: true }
  try {
    const value: unknown = JSON.parse(serialized)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid')
    const policy = value as Record<string, unknown>
    if (
      Object.keys(policy).some(
        key => key !== 'allowedTools' && key !== 'disallowedTools',
      )
    )
      throw new Error('invalid')
    for (const key of ['allowedTools', 'disallowedTools']) {
      if (key in policy && !validNames(policy[key])) throw new Error('invalid')
    }
    const allow = policy.allowedTools as string[] | undefined
    const deny = policy.disallowedTools as string[] | undefined
    if (
      deny?.some(pattern => matches(pattern, toolName)) ||
      (allow !== undefined &&
        !allow.some(pattern => matches(pattern, toolName)))
    ) {
      return { allowed: false, reason: 'not_allowed' }
    }
    return { allowed: true }
  } catch {
    return { allowed: false, reason: 'invalid_policy' }
  }
}

/** 即使上游 hooks 已给出 forceDecision，也必须先应用宿主工具范围。 */
export function hostToolDenial(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): PermissionDenyDecision | null {
  const decision = evaluateHostToolPolicy(getToolNameForPermissionCheck(tool))
  if (decision.allowed) return null
  const invalid = decision.reason === 'invalid_policy'
  return {
    behavior: 'deny',
    decisionReason: {
      type: 'other',
      reason: invalid
        ? 'Desktop host tool policy is invalid'
        : 'Desktop host tool policy does not allow this tool',
    },
    message: invalid
      ? 'Tool use denied because the desktop host tool policy is invalid.'
      : `The desktop host policy does not allow ${tool.name}.`,
  }
}
