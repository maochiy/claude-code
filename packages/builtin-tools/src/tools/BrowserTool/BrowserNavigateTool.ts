import { z } from 'zod/v4'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  BROWSER_WORKFLOW_PROMPT,
  getBrowserBackend,
  kickOffNativeHostInstall,
  mapBrowserOutput,
  resolveBrowserScope,
  type BrowserToolOutput,
} from './shared/browserContext.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().describe('要打开的 http/https URL'),
    title: z.string().optional().describe('任务标题（记录用，可选）'),
    taskId: z
      .string()
      .optional()
      .describe(
        '浏览器任务 ID，同一会话内复用；多标签操作时才需显式传，默认 main',
      ),
  }),
)

export const BrowserNavigateTool = buildTool({
  name: 'BrowserNavigate',
  searchHint: 'browser open url navigate background tab',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '在当前会话专属的后台标签里打开 URL（不激活标签、不抢焦点）'
  },
  async prompt() {
    return `Open a URL in this session's background tab. The tab automatically joins the session-named Chrome tab group and runs in the background — the user's current page and window focus are never disturbed. First use for a task creates the tab; later calls navigate the same tab.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions(input) {
    return { behavior: 'ask', message: `Browser: 在后台标签打开 ${input.url}` }
  },

  renderToolUseMessage(input) {
    return `Browser navigate: ${input.url ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    kickOffNativeHostInstall()
    const scope = resolveBrowserScope(context)
    const result = await getBrowserBackend().navigate({
      ...scope,
      taskId: input.taskId ?? 'main',
      url: input.url,
      title: input.title,
    })
    return {
      data: {
        kind: 'data' as const,
        data: result as Record<string, unknown>,
      },
    }
  },
})
