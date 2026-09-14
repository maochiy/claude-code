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
    ref: z.string().describe('BrowserGetState 返回的输入元素 ref（如 "s1:5"）'),
    text: z.string().describe('要输入的文本（会替换已有内容）'),
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserTypeTool = buildTool({
  name: 'BrowserType',
  searchHint: 'browser type text input field',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '向 ref 对应的输入元素输入文本'
  },
  async prompt() {
    return `Type text into an input element by its \`ref\` from the latest BrowserGetState. The text replaces existing content; a read-back verifies the value landed (falls back to direct DOM write if needed). Submit with BrowserPress Enter afterwards.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions() {
    return { behavior: 'ask', message: 'Browser: 在页面输入文本' }
  },

  renderToolUseMessage(input) {
    return `Browser type → ${input.ref ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const result = await getBrowserBackend().action('page.type', {
      ...scope,
      taskId: input.taskId ?? 'main',
      ref: input.ref,
      text: input.text,
    })
    return {
      data: {
        kind: 'data' as const,
        data: (result ?? { ok: true }) as Record<string, unknown>,
      },
    }
  },
})
