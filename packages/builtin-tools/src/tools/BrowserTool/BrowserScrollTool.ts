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
    direction: z
      .enum(['up', 'down'])
      .optional()
      .describe('滚动方向，默认 down'),
    amount: z.number().optional().describe('滚动像素数，默认 500'),
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserScrollTool = buildTool({
  name: 'BrowserScroll',
  searchHint: 'browser scroll page up down',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '滚动会话后台标签的页面'
  },
  async prompt() {
    return `Scroll the background tab's page up or down by a pixel amount (default 500). Scrolls at the viewport center via CDP mouse wheel.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions() {
    return { behavior: 'ask', message: 'Browser: 滚动页面' }
  },

  renderToolUseMessage(input) {
    return `Browser scroll ${input.direction ?? 'down'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const amount = input.amount ?? 500
    const y = input.direction === 'up' ? -amount : amount
    const result = await getBrowserBackend().action('page.scroll', {
      ...scope,
      taskId: input.taskId ?? 'main',
      x: 0,
      y,
    })
    return {
      data: {
        kind: 'data' as const,
        data: (result ?? { ok: true, x: 0, y }) as Record<string, unknown>,
      },
    }
  },
})
