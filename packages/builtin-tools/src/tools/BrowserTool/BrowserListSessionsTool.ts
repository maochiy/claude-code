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

export const BrowserListSessionsTool = buildTool({
  name: 'BrowserListSessions',
  searchHint: 'browser list sessions groups diagnostic',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema() {
    return inputSchema()
  },

  async description() {
    return '列出扩展维护的会话标签组状态（诊断用）'
  },
  async prompt() {
    return `List the session tab groups the extension maintains (group name, tab counts, ownership) — diagnostics for the session ↔ tab-group mapping. Read-only.`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage() {
    return 'Browser list_sessions'
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserToolOutput,
    toolUseID: string,
  ) {
    return mapBrowserOutput(content, toolUseID)
  },

  async call(_input, context) {
    const scope = resolveBrowserScope(context)
    const sessions = await getBrowserBackend().listSessions(scope)
    return {
      data: {
        kind: 'data' as const,
        data: (sessions ?? {}) as Record<string, unknown>,
      },
    }
  },
})
