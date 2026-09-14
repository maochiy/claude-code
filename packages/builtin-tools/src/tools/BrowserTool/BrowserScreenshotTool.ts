import { z } from 'zod/v4'
import { BrowserError } from '@claude-code-best/browser-use'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  BROWSER_WORKFLOW_PROMPT,
  getBrowserBackend,
  mapBrowserOutput,
  resolveBrowserScope,
  type BrowserToolOutput,
} from './shared/browserContext.js'

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

type ShotResult = {
  base64?: string
  data?: string
  mediaType?: string
  mode?: string
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z
      .string()
      .optional()
      .describe('浏览器任务 ID；多标签操作时才需显式传，默认 main'),
  }),
)

export const BrowserScreenshotTool = buildTool({
  name: 'BrowserScreenshot',
  searchHint: 'browser screenshot capture image page',
  // 截图以 image block 回传，落盘预览会破坏图片语义——像 Read 一样永不持久化
  maxResultSizeChars: Number.POSITIVE_INFINITY,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '在后台截取当前会话标签的画面（标签不必可见）'
  },
  async prompt() {
    return `Capture a screenshot of the session's background tab. Uses CDP, so the tab does not need to be visible and is never brought to the front. Returns an image you can use to visually verify page state before/after actions.

${BROWSER_WORKFLOW_PROMPT}`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage() {
    return 'Browser screenshot'
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(input, context) {
    const scope = resolveBrowserScope(context)
    const shot = (await getBrowserBackend().action('page.screenshot', {
      ...scope,
      taskId: input.taskId ?? 'main',
    })) as ShotResult | undefined
    const base64 = shot?.base64 || shot?.data
    if (!base64) {
      throw new BrowserError('SCREENSHOT_FAILED', '扩展未返回截图数据')
    }
    if (base64.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError('MESSAGE_TOO_LARGE', '截图数据超过 8MB 限制')
    }
    return {
      data: {
        kind: 'image' as const,
        text: `已截图（${shot?.mode === 'cdp' ? '后台 CDP' : '可见标签'}）`,
        base64,
        mediaType: shot?.mediaType || 'image/jpeg',
      },
    }
  },
})
