import type { LocalCliSlashCommand } from '@proma/shared'

export interface AgentSlashCommand {
  id: string
  label: string
  value: string
  description?: string
  argumentHint?: string
  uiAction?: AgentSlashUiAction
}

export type AgentSlashUiAction = 'clear-session' | 'enable-plan-mode' | 'open-model-selector'

export interface AgentSlashSkillCandidate {
  id: string
  name: string
  description?: string
}

export type AgentSlashSuggestion =
  | { kind: 'command'; command: AgentSlashCommand }
  | { kind: 'skill'; skill: AgentSlashSkillCandidate }

export type AgentSlashSelection =
  | { type: 'text'; text: string }
  | { type: 'mention'; id: string; label: string }
  | { type: 'action'; action: AgentSlashUiAction }

const COMMAND_UI_ACTIONS: Readonly<Record<string, AgentSlashUiAction>> = {
  clear: 'clear-session',
  plan: 'enable-plan-mode',
  model: 'open-model-selector',
}

/** `/clear` 的桌面别名必须在发送前拦截，不能作为普通文本交给模型。 */
export function isAgentClearCommand(text: string): boolean {
  return /^\/(?:clear|reset|new)\s*$/i.test(text)
}

/** 将 initialize 返回的原生命令映射为桌面候选，不补写 CLI 未声明的命令。 */
export function buildAgentSlashCommands(
  runtimeCommands: readonly LocalCliSlashCommand[],
  availableUiActions: readonly AgentSlashUiAction[] = [],
): AgentSlashCommand[] {
  return runtimeCommands.map((runtimeCommand) => {
    const id = runtimeCommand.name.replace(/^\/+/, '')
    const uiAction = COMMAND_UI_ACTIONS[id]
    return {
      id,
      label: id,
      value: `/${id}`,
      description: runtimeCommand.description,
      argumentHint: runtimeCommand.argumentHint,
      ...(uiAction && availableUiActions.includes(uiAction) ? { uiAction } : {}),
    }
  })
}

function matchesQuery(values: readonly string[], query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  return !normalizedQuery || values.some((value) => value.toLowerCase().includes(normalizedQuery))
}

/**
 * CLI 的命令目录可能把来源标记附在名称后；匹配时忽略标记，但保留原值用于展示和执行。
 * 上游已按实际解析优先级排序，因此同名项始终保留最先出现的一项。
 */
function normalizeInvocationName(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\s+\((?:project|user|local|managed|policy|bundled|plugin)\)$/i, '')
    .trim()
    .toLowerCase()
}

function getSkillInvocationNames(skill: AgentSlashSkillCandidate): string[] {
  return [...new Set([
    normalizeInvocationName(skill.id),
    normalizeInvocationName(skill.name),
  ].filter(Boolean))]
}

/** 命令与 Skill 共用同一过滤规则，命令排在 Skill 前面。 */
export function buildAgentSlashSuggestions(
  skills: readonly AgentSlashSkillCandidate[],
  query: string,
  availableUiActions: readonly AgentSlashUiAction[] = [],
  runtimeCommands: readonly LocalCliSlashCommand[] = [],
): AgentSlashSuggestion[] {
  const seenCommandNames = new Set<string>()
  const allCommands = buildAgentSlashCommands(runtimeCommands, availableUiActions)
    .filter((command) => {
      const invocationName = normalizeInvocationName(command.id)
      if (!invocationName || seenCommandNames.has(invocationName)) return false
      seenCommandNames.add(invocationName)
      return true
    })

  const commands = allCommands
    .filter((command) => matchesQuery([command.id, command.label, command.value], query))
    .map((command): AgentSlashSuggestion => ({ kind: 'command', command }))

  const commandNames = new Set(allCommands.map((command) => normalizeInvocationName(command.id)))
  const seenSkillNames = new Set<string>()
  const skillSuggestions = skills
    .filter((skill) => {
      const invocationNames = getSkillInvocationNames(skill)
      if (invocationNames.some((name) => commandNames.has(name))) return false
      if (invocationNames.some((name) => seenSkillNames.has(name))) return false
      for (const name of invocationNames) seenSkillNames.add(name)
      return true
    })
    .filter((skill) => matchesQuery([skill.id, skill.name], query))
    .map((skill): AgentSlashSuggestion => ({ kind: 'skill', skill }))

  return [...commands, ...skillSuggestions]
}

/** 命令插入为纯文本，Skill 保持结构化 Mention；两者都不会在选择时直接发送。 */
export function resolveAgentSlashSelection(
  suggestion: AgentSlashSuggestion,
): AgentSlashSelection {
  if (suggestion.kind === 'command') {
    if (suggestion.command.uiAction) {
      return { type: 'action', action: suggestion.command.uiAction }
    }
    return { type: 'text', text: `${suggestion.command.value} ` }
  }
  return {
    type: 'mention',
    id: suggestion.skill.id,
    label: suggestion.skill.name,
  }
}

interface AgentSlashUiActionHandlers {
  clearSession: () => void
  enablePlanMode: () => void
  openModelSelector: () => void
}

/** 将输入区命令分派到现有 UI 能力，不经过消息发送链路。 */
export function executeAgentSlashUiAction(
  action: AgentSlashUiAction,
  handlers: AgentSlashUiActionHandlers,
): void {
  if (action === 'clear-session') {
    handlers.clearSession()
    return
  }
  if (action === 'enable-plan-mode') {
    handlers.enablePlanMode()
    return
  }
  handlers.openModelSelector()
}
