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
    ref: z.string().describe('BrowserGetState 返回的元素 ref（如 "s1:3"）'),
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserClickTool = buildTool({
  name: 'BrowserClick',
  searchHint: 'browser click element ref mouse',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '点击页面元素（按 BrowserGetState 返回的 ref）'
  },
  async prompt() {
    return `Click a page element by its \`ref\` from the latest BrowserGetState. Sends real mouse events via CDP on the background tab. If the ref is stale (page changed since the last snapshot), re-read state first.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions() {
    return { behavior: 'ask', message: 'Browser: 点击页面元素' }
  },

  renderToolUseMessage(input) {
    return `Browser click ${input.ref ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const result = await getBrowserBackend().action('page.click', {
      ...scope,
      taskId: input.taskId ?? 'main',
      ref: input.ref,
    })
    return {
      data: {
        kind: 'data' as const,
        data: (result ?? { ok: true }) as Record<string, unknown>,
      },
    }
  },
})
