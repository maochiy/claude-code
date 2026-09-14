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
    key: z
      .string()
      .describe(
        '按键名：Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、空格、F1-F12',
      ),
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserPressTool = buildTool({
  name: 'BrowserPress',
  searchHint: 'browser keyboard press key enter',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '向会话后台标签发送按键（Enter、Tab、Escape 等）'
  },
  async prompt() {
    return `Send a key press to the background tab (goes to the focused element). Supported keys: Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space, F1-F12. Commonly used after BrowserType to submit a form.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions(input) {
    return { behavior: 'ask', message: `Browser: 按键 ${input.key}` }
  },

  renderToolUseMessage(input) {
    return `Browser press ${input.key ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const result = await getBrowserBackend().action('page.press', {
      ...scope,
      taskId: input.taskId ?? 'main',
      key: input.key,
    })
    return {
      data: {
        kind: 'data' as const,
        data: (result ?? { ok: true }) as Record<string, unknown>,
      },
    }
  },
})
