import { z } from 'zod/v4'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  getBrowserBackend,
  mapBrowserOutput,
  resolveBrowserScope,
  type BrowserToolOutput,
} from './shared/browserContext.js'

const inputSchema = lazySchema(() => z.strictObject({}))

export const BrowserListTabsTool = buildTool({
  name: 'BrowserListTabs',
  searchHint: 'browser list tabs open pages',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '列出 Chrome 扩展可见的标签页摘要（含所属会话与归属）'
  },
  async prompt() {
    return `List tabs visible to the browser extension: tab IDs, titles, URLs, owning session group, and ownership. Use a tabId from here with BrowserAttach to attach a tab the user already has open. Read-only.`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage() {
    return 'Browser list_tabs'
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(_input, context) {
    const scope = resolveBrowserScope(context)
    const tabs = await getBrowserBackend().listTabs(scope)
    return {
      data: {
        kind: 'data' as const,
        data: (tabs ?? {}) as Record<string, unknown>,
      },
    }
  },
})
