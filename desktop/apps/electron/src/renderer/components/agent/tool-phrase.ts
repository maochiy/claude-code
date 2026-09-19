/**
 * 工具语义化短语生成器
 *
 * 将工具名 + 输入参数合成为一句连贯、可读的英文短语，
 * 用于工具活动行的收起态展示和 Loading 态展示。
 * 文案对齐参考截图的桌面端样式（Read foo.ts / Ran npm test）。
 */

import { computeDiffStats } from './tool-utils'
import type { InterfaceLanguage } from '@/lib/i18n'

/** 工具短语 */
export interface ToolPhrase {
  /** 完成态/收起态短语，如 "Read foo.ts" */
  label: string
  /** Loading 态短语，如 "Reading foo.ts" */
  loadingLabel: string
  /** 编辑/写入的增删行数统计，独立于 label，便于 UI 单独渲染且不被路径截断 */
  diffStats?: { additions: number; deletions: number }
}

/** 从路径中提取文件名（同时兼容 POSIX `/` 与 Windows `\` 分隔符） */
function filename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/** 截断文本 */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 构造过去式/进行时短语对（宾语可选） */
function verb(past: string, ing: string, object = ''): ToolPhrase {
  return {
    label: object ? `${past} ${object}` : past,
    loadingLabel: object ? `${ing} ${object}` : ing,
  }
}

function zhVerb(completed: string, running: string, object = ''): ToolPhrase {
  return {
    label: object ? `${completed}${object}` : completed,
    loadingLabel: object ? `${running}${object}` : running,
  }
}

function getChineseToolPhrase(toolName: string, input: Record<string, unknown>): ToolPhrase {
  const filePath = input.file_path ?? input.filePath ?? input.notebook_path
  const fileName = typeof filePath === 'string' ? filename(filePath) : '文件'
  switch (toolName) {
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset !== undefined && limit !== undefined) {
        return zhVerb('读取了 ', '正在读取 ', `${fileName} 第 ${offset}-${offset + limit} 行`)
      }
      if (offset !== undefined) return zhVerb('读取了 ', '正在读取 ', `${fileName}，从第 ${offset} 行开始`)
      return zhVerb('读取了 ', '正在读取 ', fileName)
    }
    case 'Edit': {
      const diff = computeDiffStats('Edit', input)
      const phrase = zhVerb('编辑了 ', '正在编辑 ', fileName)
      return diff && (diff.additions > 0 || diff.deletions > 0) ? { ...phrase, diffStats: diff } : phrase
    }
    case 'Write': {
      const additions = countContentLines(input.content)
      const phrase = zhVerb('写入了 ', '正在写入 ', fileName)
      return additions > 0 ? { ...phrase, diffStats: { additions, deletions: 0 } } : phrase
    }
    case 'Bash': {
      const command = typeof input.command === 'string' ? truncate(input.command, 80) : '命令'
      return zhVerb('运行了 ', '正在运行 ', command)
    }
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? `“${truncate(input.pattern, 60)}”` : '内容'
      const path = typeof input.path === 'string' ? `${input.path} 中的` : ''
      return zhVerb('搜索了 ', '正在搜索 ', `${path}${pattern}`)
    }
    case 'Glob': {
      const path = typeof input.path === 'string' ? input.path : '文件'
      return zhVerb('搜索了 ', '正在搜索 ', path)
    }
    case 'WebFetch':
    case 'mcp__web_search__WebFetch':
      return zhVerb('抓取了 ', '正在抓取 ', typeof input.url === 'string' ? truncate(input.url, 60) : '网页')
    case 'WebSearch':
    case 'mcp__web_search__WebSearch':
      return zhVerb('搜索了网页 ', '正在搜索网页 ', typeof input.query === 'string' ? `“${truncate(input.query, 60)}”` : '')
    case 'TaskCreate': return zhVerb('创建了任务 ', '正在创建任务 ', typeof input.subject === 'string' ? truncate(input.subject, 80) : '')
    case 'TaskUpdate': return zhVerb('更新了任务 ', '正在更新任务 ', typeof input.taskId === 'string' ? `#${input.taskId}` : '')
    case 'TaskGet': return zhVerb('查看了任务 ', '正在查看任务 ', typeof input.taskId === 'string' ? `#${input.taskId}` : '')
    case 'TaskList': return zhVerb('列出了任务', '正在列出任务')
    case 'TodoWrite': return zhVerb('更新了待办', '正在更新待办')
    case 'TodoRead': return zhVerb('读取了待办', '正在读取待办')
    case 'Agent':
    case 'Task': {
      const name = typeof input.name === 'string' ? input.name : '子智能体'
      return zhVerb('运行了 ', '正在运行 ', name)
    }
    case 'Skill': return zhVerb('使用了技能 ', '正在使用技能 ', typeof input.skill === 'string' ? input.skill : '')
    case 'NotebookEdit': return zhVerb('编辑了笔记本 ', '正在编辑笔记本 ', fileName)
    case 'EnterPlanMode': return zhVerb('进入了计划模式', '正在进入计划模式')
    case 'ExitPlanMode': return zhVerb('退出了计划模式', '正在退出计划模式')
    case 'TaskOutput': return zhVerb('读取了任务输出 ', '正在读取任务输出 ', formatTaskId(input))
    case 'TaskStop': return zhVerb('停止了任务 ', '正在停止任务 ', formatTaskId(input))
    case 'AskUserQuestion': return zhVerb('询问了用户', '正在等待用户输入')
    case 'REPL': return zhVerb('运行了 REPL', '正在运行 REPL')
    case 'Workflow': return zhVerb('运行了工作流', '正在运行工作流')
    case 'ScheduleWakeup': return zhVerb('安排了唤醒', '正在安排唤醒')
    case 'Monitor': return zhVerb('监控了任务', '正在监控任务')
    case 'PushNotification': return zhVerb('发送了通知', '正在发送通知')
    case 'CronCreate': return zhVerb('创建了定时任务', '正在创建定时任务')
    case 'CronDelete': return zhVerb('删除了定时任务', '正在删除定时任务')
    case 'CronList': return zhVerb('列出了定时任务', '正在列出定时任务')
    case 'EnterWorktree': return zhVerb('进入了 Worktree', '正在进入 Worktree')
    case 'ExitWorktree': return zhVerb('退出了 Worktree', '正在退出 Worktree')
    case 'generate_image': return zhVerb('生成了图片', '正在生成图片')
    default: {
      const summary = extractFirstMeaningfulValue(input)
      const target = summary ? `${toolName} ${truncate(summary, 60)}` : toolName
      return zhVerb('调用了 ', '正在调用 ', target)
    }
  }
}

function countContentLines(value: unknown): number {
  return typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0
}

function formatTaskId(input: Record<string, unknown>): string {
  const value = input.task_id ?? input.taskId
  return typeof value === 'string' ? `#${value}` : ''
}

/**
 * 根据工具名和输入参数生成语义化短语
 *
 * 返回的 label 应读起来像一个完整动宾短语，无冗余信息。
 */
export function getToolPhrase(
  toolName: string,
  input: Record<string, unknown>,
  language: InterfaceLanguage = 'en',
): ToolPhrase {
  if (language === 'zh') return getChineseToolPhrase(toolName, input)
  switch (toolName) {
    case 'Read': {
      const fp = input.file_path ?? input.filePath
      if (typeof fp === 'string') {
        const name = filename(fp)
        const offset = typeof input.offset === 'number' ? input.offset : undefined
        const limit = typeof input.limit === 'number' ? input.limit : undefined
        if (offset !== undefined && limit !== undefined) {
          return verb('Read', 'Reading', `${name} lines ${offset}-${offset + limit}`)
        }
        if (offset !== undefined) {
          return verb('Read', 'Reading', `${name} from line ${offset}`)
        }
        return verb('Read', 'Reading', name)
      }
      return verb('Read', 'Reading', 'file')
    }

    case 'Edit': {
      const fp = input.file_path ?? input.filePath
      const name = typeof fp === 'string' ? filename(fp) : 'file'
      const diff = computeDiffStats('Edit', input)
      if (diff && (diff.additions > 0 || diff.deletions > 0)) {
        return { ...verb('Edited', 'Editing', name), diffStats: diff }
      }
      return verb('Edited', 'Editing', name)
    }

    case 'Write': {
      const fp = input.file_path ?? input.filePath
      const name = typeof fp === 'string' ? filename(fp) : 'file'
      const content = input.content
      if (typeof content === 'string' && content.length > 0) {
        const lines = content.split('\n').length
        return { ...verb('Wrote', 'Writing', name), diffStats: { additions: lines, deletions: 0 } }
      }
      return verb('Wrote', 'Writing', name)
    }

    case 'Bash': {
      const cmd = input.command
      if (typeof cmd === 'string') {
        // 命令直接展示：Running <cmd> / Ran <cmd>
        return { label: `Ran ${truncate(cmd, 80)}`, loadingLabel: `Running ${truncate(cmd, 80)}` }
      }
      return verb('Ran', 'Running', 'command')
    }

  case 'Grep': {
    const pattern = input.pattern
    if (typeof pattern === 'string') {
      const path = input.path
      const quoted = `"${truncate(pattern, 60)}"`
      if (typeof path === 'string') {
        return {
          label: `Searched ${path} for ${quoted}`,
          loadingLabel: `Searching ${path} for ${quoted}`,
        }
      }
      return {
        label: `Searched for ${quoted}`,
        loadingLabel: `Searching for ${quoted}`,
      }
    }
    return verb('Searched', 'Searching', 'content')
  }

    case 'Glob': {
      const path = input.path
      if (typeof path === 'string') {
        return verb('Searched', 'Searching', path)
      }
      return verb('Searched', 'Searching', 'files')
    }

    case 'WebFetch':
    case 'mcp__web_search__WebFetch': {
      const url = input.url
      if (typeof url === 'string') {
        return verb('Fetched', 'Fetching', truncate(url, 60))
      }
      return verb('Fetched', 'Fetching', 'page')
    }

    case 'WebSearch':
    case 'mcp__web_search__WebSearch': {
      const query = input.query
      if (typeof query === 'string') {
        return {
          label: `Searched the web for "${truncate(query, 60)}"`,
          loadingLabel: `Searching the web for "${truncate(query, 60)}"`,
        }
      }
      return { label: 'Searched the web', loadingLabel: 'Searching the web' }
    }

    case 'Skill': {
      const skill = input.skill
      if (typeof skill === 'string') {
        return verb('Used', 'Using', `skill ${skill}`)
      }
      return verb('Used', 'Using', 'skill')
    }

    case 'NotebookEdit': {
      const fp = input.notebook_path
      if (typeof fp === 'string') {
        return verb('Edited', 'Editing', `notebook ${filename(fp)}`)
      }
      return verb('Edited', 'Editing', 'notebook')
    }

    case 'Task': {
      const desc = input.description ?? input.prompt
      if (typeof desc === 'string') {
        return verb('Ran', 'Running', `task ${truncate(desc, 80)}`)
      }
      return verb('Ran', 'Running', 'task')
    }

    case 'Agent': {
      const name = input.name
      const desc = input.description ?? input.prompt
      if (typeof name === 'string' && typeof desc === 'string') {
        return verb('Ran', 'Running', `Agent ${name} · ${truncate(desc, 60)}`)
      }
      if (typeof desc === 'string') return verb('Ran', 'Running', `Agent ${truncate(desc, 80)}`)
      if (typeof name === 'string') return verb('Ran', 'Running', `Agent ${name}`)
      return verb('Ran', 'Running', 'Agent')
    }

    case 'TaskCreate': {
      const subject = input.subject
      if (typeof subject === 'string') {
        return verb('Created', 'Creating', `task ${truncate(subject, 80)}`)
      }
      return verb('Created', 'Creating', 'task')
    }

    case 'TaskUpdate': {
      // TaskUpdate 是自描述工具，label 即完整语义
      const statusMap: Record<string, string> = {
        pending: 'Pending',
        in_progress: 'In progress',
        completed: 'Completed',
        cancelled: 'Cancelled',
        blocked: 'Blocked',
        error: 'Error',
        deleted: 'Deleted',
      }
      const parts: string[] = []
      if (typeof input.taskId === 'string') parts.push(`task #${input.taskId}`)
      if (typeof input.status === 'string') parts.push(statusMap[input.status] ?? input.status)
      if (typeof input.subject === 'string') parts.push(truncate(input.subject, 60))
      if (parts.length > 0) return verb('Updated', 'Updating', parts.join(' '))
      return verb('Updated', 'Updating', 'task')
    }

    case 'TaskGet': {
      const taskId = input.taskId
      if (typeof taskId === 'string') return verb('Viewed', 'Viewing', `task #${taskId}`)
      return verb('Viewed', 'Viewing', 'task')
    }

    case 'TaskList': {
      return verb('Listed', 'Listing', 'tasks')
    }

    case 'TodoWrite': {
      const todos = input.todos
      if (Array.isArray(todos)) {
        return verb('Updated', 'Updating', `${todos.length} todos`)
      }
      return verb('Updated', 'Updating', 'todos')
    }

    case 'TodoRead': {
      return verb('Read', 'Reading', 'todos')
    }

    case 'EnterPlanMode': {
      return verb('Entered', 'Entering', 'plan mode')
    }

    case 'ExitPlanMode': {
      return verb('Exited', 'Exiting', 'plan mode')
    }

    case 'generate_image': {
      const prompt = input.prompt
      if (typeof prompt === 'string') return verb('Generated', 'Generating', `image ${truncate(prompt, 60)}`)
      return verb('Generated', 'Generating', 'image')
    }

    case 'TaskOutput': {
      const taskId = input.task_id ?? input.taskId
      if (typeof taskId === 'string') return verb('Read', 'Reading', `task #${taskId} output`)
      return verb('Read', 'Reading', 'task output')
    }

    case 'TaskStop': {
      const taskId = input.task_id ?? input.taskId
      if (typeof taskId === 'string') return verb('Stopped', 'Stopping', `task #${taskId}`)
      return verb('Stopped', 'Stopping', 'task')
    }

    case 'AskUserQuestion': {
      const questions = input.questions
      if (Array.isArray(questions) && questions.length > 0) {
        const first = questions[0] as Record<string, unknown>
        if (typeof first.question === 'string') {
          return verb('Asked', 'Asking', truncate(first.question, 60))
        }
      }
      return verb('Asked', 'Asking', 'user')
    }

    case 'REPL': {
      const description = input.description
      const code = input.code
      if (typeof description === 'string' && description.trim()) return verb('Ran', 'Running', `REPL ${truncate(description, 50)}`)
      if (typeof code === 'string') return verb('Ran', 'Running', `REPL ${truncate(code, 50)}`)
      return verb('Ran', 'Running', 'REPL')
    }

    case 'Workflow': {
      const name = input.name
      const scriptPath = input.scriptPath
      if (typeof name === 'string') return verb('Ran', 'Running', `workflow ${name}`)
      if (typeof scriptPath === 'string') return verb('Ran', 'Running', `workflow ${filename(scriptPath)}`)
      return verb('Ran', 'Running', 'workflow')
    }

    case 'ScheduleWakeup': {
      const delaySeconds = input.delaySeconds
      const reason = input.reason
      if (typeof delaySeconds === 'number' && typeof reason === 'string') {
        return verb('Scheduled', 'Scheduling', `wakeup in ${delaySeconds}s · ${truncate(reason, 40)}`)
      }
      if (typeof delaySeconds === 'number') return verb('Scheduled', 'Scheduling', `wakeup in ${delaySeconds}s`)
      return verb('Scheduled', 'Scheduling', 'wakeup')
    }

    case 'Monitor': {
      const description = input.description
      if (typeof description === 'string') return verb('Monitored', 'Monitoring', truncate(description, 50))
      return verb('Monitored', 'Monitoring', 'task')
    }

    case 'PushNotification': {
      const message = input.message
      if (typeof message === 'string') return verb('Sent', 'Sending', `notification ${truncate(message, 50)}`)
      return verb('Sent', 'Sending', 'notification')
    }

    case 'CronCreate': {
      const cron = input.cron
      const prompt = input.prompt
      if (typeof cron === 'string' && typeof prompt === 'string') {
        return verb('Created', 'Creating', `cron ${cron} · ${truncate(prompt, 40)}`)
      }
      if (typeof cron === 'string') return verb('Created', 'Creating', `cron ${cron}`)
      return verb('Created', 'Creating', 'cron job')
    }

    case 'CronDelete': {
      const id = input.id
      if (typeof id === 'string') return verb('Deleted', 'Deleting', `cron ${id}`)
      return verb('Deleted', 'Deleting', 'cron job')
    }

    case 'CronList': {
      return verb('Listed', 'Listing', 'cron jobs')
    }

    case 'RemoteTrigger': {
      const action = input.action
      const triggerId = input.trigger_id
      const actionMap: Record<string, [string, string]> = {
        list: ['Listed', 'Listing'],
        get: ['Fetched', 'Fetching'],
        create: ['Created', 'Creating'],
        update: ['Updated', 'Updating'],
        run: ['Ran', 'Running'],
      }
      const [past, ing] = typeof action === 'string' ? (actionMap[action] ?? ['Called', 'Calling']) : ['Called', 'Calling']
      if (typeof triggerId === 'string') {
        return verb(past, ing, `trigger ${triggerId}`)
      }
      return verb(past, ing, 'trigger')
    }

    case 'EnterWorktree': {
      const name = input.name
      if (typeof name === 'string') return verb('Entered', 'Entering', `worktree ${name}`)
      return verb('Entered', 'Entering', 'worktree')
    }

    case 'ExitWorktree': {
      if (input.action === 'remove') return verb('Exited and removed', 'Exiting', 'worktree')
      return verb('Exited', 'Exiting', 'worktree')
    }

    case 'ReadMcpResourceTool': {
      const server = input.server
      const uri = input.uri
      if (typeof server === 'string' && typeof uri === 'string') {
        return verb('Read', 'Reading', `MCP resource ${server} / ${truncate(uri, 40)}`)
      }
      if (typeof uri === 'string') return verb('Read', 'Reading', `MCP resource ${truncate(uri, 60)}`)
      return verb('Read', 'Reading', 'MCP resource')
    }

    case 'ListMcpResourcesTool': {
      const server = input.server
      if (typeof server === 'string') return verb('Listed', 'Listing', `MCP resources for ${server}`)
      return verb('Listed', 'Listing', 'MCP resources')
    }

    case 'SendMessage': {
      const to = input.to
      if (typeof to === 'string') return verb('Sent', 'Sending', `message to ${to}`)
      return verb('Sent', 'Sending', 'message')
    }

    default: {
      // MCP 工具：mcp__serverName__toolName
      const mcpParts = toolName.split('__')
      if (mcpParts[0] === 'mcp' && mcpParts.length >= 3 && mcpParts[1]) {
        const server = mcpParts[1].toUpperCase()
        const tool = mcpParts.slice(2).join('_')
        // 尝试从 input 中提取第一个有意义的参数作为摘要
        const summary = extractFirstMeaningfulValue(input)
        if (summary) {
          return verb('Called', 'Calling', `${server} / ${tool} ${truncate(summary, 60)}`)
        }
        return verb('Called', 'Calling', `${server} / ${tool}`)
      }
      // 未知工具
      const summary = extractFirstMeaningfulValue(input)
      if (summary) {
        return verb('Called', 'Calling', `${toolName} ${truncate(summary, 60)}`)
      }
      return verb('Called', 'Calling', toolName)
    }
  }
}

/** 从 input 中提取第一个有意义的字符串值作为摘要 */
function extractFirstMeaningfulValue(input: Record<string, unknown>): string | null {
  // 优先检查常见的描述性字段
  const priorityKeys = ['description', 'prompt', 'query', 'command', 'name', 'subject', 'path', 'file_path', 'url']
  for (const key of priorityKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  // 回退到第一个非下划线开头的字符串值
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith('_') && typeof value === 'string' && value.length > 0 && value.length < 200) {
      return value
    }
  }
  return null
}
