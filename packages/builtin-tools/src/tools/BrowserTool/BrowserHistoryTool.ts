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
    action: z
      .enum(['back', 'forward', 'reload'])
      .describe('后退 / 前进 / 重新加载'),
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserHistoryTool = buildTool({
  name: 'BrowserHistory',
  searchHint: 'browser back forward reload navigation history',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '后退 / 前进 / 重新加载会话后台标签的页面'
  },
  async prompt() {
    return `Navigate the background tab's history: back, forward, or reload. After the action, re-read BrowserGetState — refs from before are stale.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions(input) {
    const label =
      input.action === 'back'
        ? '后退'
        : input.action === 'forward'
          ? '前进'
          : '重新加载'
    return { behavior: 'ask', message: `Browser: 页面${label}` }
  },

  renderToolUseMessage(input) {
    return `Browser ${input.action ?? 'reload'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const method =
      input.action === 'back'
        ? 'tabs.back'
        : input.action === 'forward'
          ? 'tabs.forward'
          : 'tabs.reload'
    const result = await getBrowserBackend().action(method, {
      ...scope,
      taskId: input.taskId ?? 'main',
    })
    return {
      data: {
        kind: 'data' as const,
        data: (result ?? { ok: true }) as Record<string, unknown>,
      },
    }
  },
})
