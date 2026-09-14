import { z } from 'zod/v4'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  BROWSER_WORKFLOW_PROMPT,
  getBrowserBackend,
  mapBrowserOutput,
  resolveBrowserScope,
  type BrowserToolOutput,
} from './shared/browserContext.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserCloseTool = buildTool({
  name: 'BrowserClose',
  searchHint: 'browser close tab detach cleanup',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '结束浏览器任务；插件创建的后台标签被关闭，用户自己的标签只断开调试'
  },
  async prompt() {
    return `Finish a browser task: tabs created by the session are closed; tabs the user owned are only detached (debugger removed, tab stays open). Call this when done with a browsing task to clean up.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions() {
    return { behavior: 'ask', message: 'Browser: 关闭后台标签' }
  },

  renderToolUseMessage(input) {
    return `Browser close ${input.taskId ?? 'main'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const result = await getBrowserBackend().close({
      ...scope,
      taskId: input.taskId ?? 'main',
    })
    return { data: { kind: 'data' as const, data: result } }
  },
})
