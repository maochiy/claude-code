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
    taskId: z
      .string()
      .optional()
      .describe(
        '浏览器任务 ID，同一会话内复用；多标签操作时才需显式传，默认 main',
      ),
    tabId: z
      .number()
      .optional()
      .describe(
        '要附加的用户已打开标签页 ID（来自 BrowserListTabs）；省略则复用或新建会话专属后台标签',
      ),
    title: z.string().optional().describe('任务标题（记录用，可选）'),
  }),
)

type AttachResult = Record<string, unknown>

export const BrowserAttachTool = buildTool({
  name: 'BrowserAttach',
  searchHint: 'browser attach tab background session group',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '确保当前会话拥有可用的浏览器后台标签并绑定任务'
  },
  async prompt() {
    return `Attach a browser tab for this session and bind it to a task. Omit tabId to reuse or create the session's own background tab (joins the session-named Chrome tab group, runs in background without stealing focus). Pass tabId (from BrowserListTabs) to attach a tab the user already has open.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  async checkPermissions(input) {
    return {
      behavior: 'ask',
      message:
        input.tabId != null
          ? `Browser: 附加用户标签页 ${input.tabId}`
          : 'Browser: 创建/复用会话后台标签',
    }
  },

  renderToolUseMessage(input) {
    return input.tabId != null
      ? `Browser attach tab ${input.tabId}`
      : 'Browser attach'
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
    const task = (await getBrowserBackend().attach({
      ...scope,
      taskId: input.taskId ?? 'main',
      tabId: input.tabId ?? null,
      title: input.title,
    })) as unknown as AttachResult
    return { data: { kind: 'data' as const, data: task } }
  },
})
