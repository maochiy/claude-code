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

export const BrowserGetStateTool = buildTool({
  name: 'BrowserGetState',
  searchHint: 'browser page state elements refs snapshot',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '读取会话后台标签的 URL、标题、正文与可交互元素 ref'
  },
  async prompt() {
    return `Read the current page state of this session's background tab: URL, title, visible text, and interactive elements (each with a stable \`ref\`). Use the ref with BrowserClick/BrowserType/BrowserPress. Re-read after navigation — refs go stale when the page changes.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage() {
    return 'Browser get_state'
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const state = await getBrowserBackend().getState({
      ...scope,
      taskId: input.taskId ?? 'main',
    })
    return {
      data: {
        kind: 'data' as const,
        data: (state ?? {}) as Record<string, unknown>,
      },
    }
  },
})
