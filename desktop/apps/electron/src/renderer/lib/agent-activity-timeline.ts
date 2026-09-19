import type { SDKToolUseBlock } from '@proma/shared'
import type { AgentActivityItem } from './agent-turn-presentation'
import type { InterfaceLanguage } from './i18n'
import { computeDiffStats, normalizeToolPresentation } from '@/components/agent/tool-utils'

export interface AgentTimelineEntry {
  id: string
  kind: 'text' | 'thinking' | 'tools' | 'other'
  items: AgentActivityItem[]
}

type ToolCategory = 'command' | 'edit' | 'file' | 'search' | 'other'

const FILE_TOOLS = new Set([
  'read',
  'read_file',
  'notebookread',
])

const COMMAND_TOOLS = new Set([
  'bash',
  'execute',
  'shell',
  'terminal',
  'run_command',
])

const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
])

const SEARCH_TOOLS = new Set([
  'grep',
  'glob',
  'search',
  'filesearch',
  'search_files',
  'find',
  'ls',
  'listdir',
])

function getTimelineKind(item: AgentActivityItem): AgentTimelineEntry['kind'] {
  switch (item.block.type) {
    case 'text':
      return 'text'
    case 'thinking':
      return 'thinking'
    case 'tool_use':
      return 'tools'
    default:
      return 'other'
  }
}

function getTimelineEntryId(item: AgentActivityItem): string {
  if (item.block.type === 'tool_use') {
    const tool = item.block as SDKToolUseBlock
    if (tool.id) return `tool:${tool.id}`
  }
  return `${item.block.type}:${item.index}`
}

function getToolCategory(item: AgentActivityItem): ToolCategory {
  if (item.block.type !== 'tool_use') return 'other'

  const toolName = (item.block as SDKToolUseBlock).name.toLowerCase()
  if (FILE_TOOLS.has(toolName)) return 'file'
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  if (SEARCH_TOOLS.has(toolName)) return 'search'
  return 'other'
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}

function getRunningToolLabel(
  tools: AgentActivityItem[],
  language: InterfaceLanguage,
): string | undefined {
  const current = tools.findLast(item => item.running)
  if (!current || current.block.type !== 'tool_use') return undefined

  const tool = current.block as SDKToolUseBlock
  const category = getToolCategory(current)

  if (category === 'file') {
    const path = nonEmptyString(tool.input.file_path)
      ?? nonEmptyString(tool.input.path)
    return path ? (language === 'zh' ? `正在读取 ${path}` : `Reading ${path}`) : undefined
  }

  if (category === 'command') {
    const description = nonEmptyString(tool.input.description)
      ?? nonEmptyString(tool.input.title)
    return description ? (language === 'zh' ? `正在运行 ${description}` : `Running ${description}`) : undefined
  }

  const name = nonEmptyString(tool.name)
  if (!name) return undefined
  return category === 'search'
    ? (language === 'zh' ? `正在搜索 ${name}` : `Searching ${name}`)
    : (language === 'zh' ? `正在调用 ${name}` : `Calling ${name}`)
}

/**
 * 按原生顺序展示；工具之间已结束的思考归入同组，正文和实时思考仍独立可见。
 */
export function buildAgentActivityTimeline(
  items: AgentActivityItem[],
): AgentTimelineEntry[] {
  const entries: AgentTimelineEntry[] = []

  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]!
    const kind = getTimelineKind(item)
    const previous = entries.at(-1)

    if (previous?.kind === 'tools' && kind === 'thinking' && !item.running) {
      let nextToolPosition = position
      while (items[nextToolPosition]?.block.type === 'thinking' && !items[nextToolPosition]?.running) {
        nextToolPosition += 1
      }
      if (items[nextToolPosition]?.block.type === 'tool_use') {
        previous.items.push(...items.slice(position, nextToolPosition + 1))
        position = nextToolPosition
        continue
      }
    }

    if ((kind === 'tools' || kind === 'thinking') && previous?.kind === kind) {
      previous.items.push(item)
      continue
    }

    entries.push({
      id: getTimelineEntryId(item),
      kind,
      items: [item],
    })
  }

  return entries
}

/**
 * 单类工具的分段摘要（Read 8 files / Ran 2 commands 风格）；
 * 组内仍有工具在运行且拿不到具体目标时，退化为进行时（Reading 1 file / Running 2 commands）。
 */
function getCategoryGroupLabel(
  category: ToolCategory,
  count: number,
  running: boolean,
  language: InterfaceLanguage,
): string {
  if (language === 'zh') {
    switch (category) {
      case 'command': return running ? `正在运行 ${count} 条命令` : `运行了 ${count} 条命令`
      case 'edit': return running ? `正在编辑 ${count} 个文件` : `编辑了 ${count} 个文件`
      case 'file': return running ? `正在读取 ${count} 个文件` : `读取了 ${count} 个文件`
      case 'search': return running ? `正在执行 ${count} 次搜索` : `执行了 ${count} 次搜索`
      case 'other':
      default: return running ? `正在调用 ${count} 个工具` : `使用了 ${count} 个工具`
    }
  }
  switch (category) {
    case 'file':
      if (running) return count === 1 ? 'Reading 1 file' : `Reading ${count} files`
      return count === 1 ? 'Read 1 file' : `Read ${count} files`
    case 'command':
      if (running) return count === 1 ? 'Running 1 command' : `Running ${count} commands`
      return count === 1 ? 'Ran 1 command' : `Ran ${count} commands`
    case 'edit':
      if (running) return count === 1 ? 'Editing 1 file' : `Editing ${count} files`
      return count === 1 ? 'Edited 1 file' : `Edited ${count} files`
    case 'search':
      if (running) return count === 1 ? 'Searching 1 item' : `Searching ${count} items`
      return count === 1 ? 'Searched 1 item' : `Searched ${count} items`
    case 'other':
    default:
      if (running) return count === 1 ? 'Calling 1 tool' : `Calling ${count} tools`
      return count === 1 ? 'Used 1 tool' : `Used ${count} tools`
  }
}

function countLines(value: unknown): number {
  return typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0
}

function getEditDiffStats(tool: SDKToolUseBlock): { additions: number; deletions: number } {
  const presentation = normalizeToolPresentation(tool.name, tool.input)
  const normalizedName = presentation.name.toLowerCase()
  if (normalizedName === 'edit') {
    return computeDiffStats('Edit', presentation.input) ?? { additions: 0, deletions: 0 }
  }
  if (normalizedName === 'write') {
    return { additions: countLines(presentation.input.content), deletions: 0 }
  }
  if (normalizedName === 'multiedit' && Array.isArray(presentation.input.edits)) {
    return presentation.input.edits.reduce((total, edit) => {
      if (typeof edit !== 'object' || edit === null) return total
      const value = edit as Record<string, unknown>
      return {
        additions: total.additions + countLines(value.new_string ?? value.newText),
        deletions: total.deletions + countLines(value.old_string ?? value.oldText),
      }
    }, { additions: 0, deletions: 0 })
  }
  return { additions: 0, deletions: 0 }
}

function getEditedFileCount(tools: AgentActivityItem[]): number {
  const paths = new Set<string>()
  let toolsWithoutPath = 0
  for (const item of tools) {
    if (item.block.type !== 'tool_use' || getToolCategory(item) !== 'edit') continue
    const tool = item.block as SDKToolUseBlock
    const input = normalizeToolPresentation(tool.name, tool.input).input
    const path = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
    if (typeof path === 'string' && path.trim()) paths.add(path)
    else toolsWithoutPath += 1
  }
  return paths.size + toolsWithoutPath
}

/**
 * 为工具组生成摘要；中间思考保留在明细中，但不计入工具数量。
 * 多类工具混排时按 文件 → 命令 → 搜索 → 其他 顺序拼接（Read 5 files, ran 2 commands）。
 */
export function getToolGroupLabel(
  items: AgentActivityItem[],
  failureCount = 0,
  language: InterfaceLanguage = 'en',
  failedToolIds?: ReadonlySet<string>,
): string {
  const tools = items.filter(item => item.block.type === 'tool_use')
  if (tools.length === 0) return language === 'zh' ? '使用了 0 个工具' : 'Used 0 tools'

  const running = tools.some((item) => item.running)
  const runningLabel = running ? getRunningToolLabel(tools, language) : undefined
  const failureSuffix = failureCount > 0
    ? language === 'zh' ? `（${failureCount} 个失败）` : ` (${failureCount} failed)`
    : ''
  if (runningLabel) return `${runningLabel}${failureSuffix}`

  const countByCategory = new Map<ToolCategory, number>()
  for (const tool of tools) {
    const category = getToolCategory(tool)
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1)
  }

  const order: ToolCategory[] = ['command', 'edit', 'file', 'search', 'other']
  const segments = order
    .filter((category) => countByCategory.has(category))
    .map((category, index) => {
      const count = category === 'edit'
        ? getEditedFileCount(tools)
        : countByCategory.get(category) ?? 0
      const label = getCategoryGroupLabel(category, count, running, language)
      return language === 'en' && index > 0
        ? `${label.charAt(0).toLowerCase()}${label.slice(1)}`
        : label
    })

  const editStats = tools.reduce((total, item) => {
    if (item.block.type !== 'tool_use' || getToolCategory(item) !== 'edit') return total
    if (failedToolIds?.has((item.block as SDKToolUseBlock).id)) return total
    const stats = getEditDiffStats(item.block as SDKToolUseBlock)
    return {
      additions: total.additions + stats.additions,
      deletions: total.deletions + stats.deletions,
    }
  }, { additions: 0, deletions: 0 })
  if (countByCategory.has('edit') && (editStats.additions > 0 || editStats.deletions > 0)) {
    const additions = editStats.additions > 0 ? ` +${editStats.additions}` : ''
    const deletions = editStats.deletions > 0 ? ` -${editStats.deletions}` : ''
    const editIndex = order.filter((category) => countByCategory.has(category)).indexOf('edit')
    segments[editIndex] = `${segments[editIndex]}${additions}${deletions}`
  }

  const separator = language === 'zh' ? '，' : ', '
  return `${segments.join(separator)}${failureSuffix}`
}
