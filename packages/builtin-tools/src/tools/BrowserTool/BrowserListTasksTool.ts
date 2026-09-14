import { z } from 'zod/v4'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  getBrowserBackend,
  mapBrowserOutput,
  resolveBrowserScope,
  type BrowserToolOutput,
} from './shared/browserContext.js'

const inputSchema = lazySchema(() => z.strictObject({}))

export const BrowserListTasksTool = buildTool({
  name: 'BrowserListTasks',
  searchHint: 'browser list tasks session tabs',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '列出当前会话的浏览器任务（含标签页与归属）'
  },
  async prompt() {
    return `List this session's browser tasks: task IDs, bound tab IDs, titles, URLs, and ownership (host-created vs user-owned). Read-only.`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage() {
    return 'Browser list_tasks'
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(_input, context) {
    const scope = resolveBrowserScope(context)
    const tasks = getBrowserBackend().listTasks({ sessionId: scope.sessionId })
    return {
      data: {
        kind: 'list' as const,
        items: tasks as unknown as Record<string, unknown>[],
      },
    }
  },
})
