import type { AgentRuntimeToolPolicy } from '@proma/shared'

const builtinNames = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell', 'Glob', 'Grep',
  'Agent', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'WebFetch',
  'WebSearch', 'ToolSearch', 'Workflow', 'LSP']
const canonicalNames = new Map(builtinNames.map(name => [name.toLowerCase(), name]))

/** 注册 Agent 的工具范围是工具名，不能混入 Bash(command) 这种权限规则。 */
function normalizeName(name: string): string {
  const value = name.trim()
  if (!value || /[()\s]/.test(value)) throw new Error(`无效的工具范围：${name}`)
  return canonicalNames.get(value.toLowerCase()) ?? value
}

export function normalizeToolPolicy(policy?: AgentRuntimeToolPolicy): AgentRuntimeToolPolicy | undefined {
  if (!policy) return undefined
  return {
    ...(policy.allowedTools !== undefined ? { allowedTools: [...new Set(policy.allowedTools.map(normalizeName))] } : {}),
    ...(policy.disallowedTools !== undefined ? { disallowedTools: [...new Set(policy.disallowedTools.map(normalizeName))] } : {}),
  }
}

function matches(pattern: string, toolName: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`).test(normalizeName(toolName))
}

export function toolPolicyAllows(policy: AgentRuntimeToolPolicy | undefined, toolName: string): boolean {
  const normalized = normalizeToolPolicy(policy)
  if (normalized?.disallowedTools?.some(pattern => matches(pattern, toolName))) return false
  return normalized?.allowedTools === undefined || normalized.allowedTools.some(pattern => matches(pattern, toolName))
}

export function availableBuiltinTools(policy: AgentRuntimeToolPolicy | undefined): string[] | undefined {
  const normalized = normalizeToolPolicy(policy)
  if (normalized?.allowedTools === undefined) return undefined
  if (normalized.allowedTools.includes('*')) return ['default']
  return [...new Set(normalized.allowedTools.filter(name => !name.startsWith('mcp__'))
    .flatMap(name => name.includes('*') ? builtinNames.filter(tool => matches(name, tool)) : [name]))]
}
