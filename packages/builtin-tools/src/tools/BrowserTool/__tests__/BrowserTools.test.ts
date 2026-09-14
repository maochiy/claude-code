import { describe, expect, test, mock, afterAll } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// 与 ExecuteTool.render.test.ts 同款 setup：工具 import 链经过 debug/log
// （shared/browserContext → src/utils/browserUse/setup → claudeInChrome/common），
// 先替换成共享 stub 再 import 被测模块。mock.module 是进程全局的，
// 但 stub 与兄弟测试文件完全一致（last-write-wins 无副作用）。
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

import type { BrowserBackend } from '@claude-code-best/browser-use'

type Call = { method: string; args: Record<string, unknown> }

/** 内存 fake 后端：记录调用并返回可断言的固定结果。 */
class FakeBackend {
  calls: Call[] = []
  screenshotBase64 = 'aGVsbG8='

  async attach(args: Record<string, unknown>) {
    this.calls.push({ method: 'attach', args })
    return {
      sessionId: args.sessionId,
      taskId: args.taskId,
      tabId: 42,
      ownership: 'host-created',
      createdAt: 1,
      reused: false,
    }
  }

  async navigate(args: Record<string, unknown>) {
    this.calls.push({ method: 'navigate', args })
    return { taskId: args.taskId, tabId: 42, url: args.url }
  }

  async getState(scope: Record<string, unknown>) {
    this.calls.push({ method: 'getState', args: scope })
    return {
      url: 'https://example.com',
      title: 'Example',
      text: 'hello world',
      elements: [{ ref: 's1:0', tag: 'a', text: 'a link' }],
    }
  }

  async action(method: string, args: Record<string, unknown>) {
    this.calls.push({ method, args })
    if (method === 'page.screenshot') {
      return {
        base64: this.screenshotBase64,
        mediaType: 'image/jpeg',
        mode: 'cdp',
      }
    }
    return { ok: true, mode: 'cdp' }
  }

  listTasks(scope: { sessionId?: string | null }) {
    this.calls.push({ method: 'listTasks', args: scope })
    return [{ taskId: 'main', tabId: 42, ownership: 'host-created' }]
  }

  async listTabs(scope: Record<string, unknown>) {
    this.calls.push({ method: 'tabs.list', args: scope })
    return { tabs: [{ tabId: 42, title: 'Example' }] }
  }

  async listSessions(scope: Record<string, unknown>) {
    this.calls.push({ method: 'sessions.list', args: scope })
    return { sessions: [{ title: '会话 abc', tabs: [] }] }
  }

  async close(args: Record<string, unknown>) {
    this.calls.push({ method: 'close', args })
    return { action: 'closed', result: {} }
  }
}

const fake = new FakeBackend()
const { setBrowserBackendForTests, resolveBrowserScope, mapBrowserOutput } =
  await import('../shared/browserContext.js')
setBrowserBackendForTests(fake as unknown as BrowserBackend)

const {
  BrowserAttachTool,
  BrowserNavigateTool,
  BrowserGetStateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  BrowserHistoryTool,
  BrowserCloseTool,
  BrowserListTasksTool,
  BrowserListTabsTool,
  BrowserListSessionsTool,
} = await import('../index.js')

afterAll(() => {
  setBrowserBackendForTests(null)
})

const ctx = {
  agentId: undefined,
  messages: [
    {
      type: 'user',
      message: { role: 'user', content: '帮我打开 example.com 看看' },
    },
  ],
} as any

describe('BrowserTools metadata', () => {
  test('all 13 tools exported with expected names', () => {
    expect(BrowserAttachTool.name).toBe('BrowserAttach')
    expect(BrowserNavigateTool.name).toBe('BrowserNavigate')
    expect(BrowserGetStateTool.name).toBe('BrowserGetState')
    expect(BrowserClickTool.name).toBe('BrowserClick')
    expect(BrowserTypeTool.name).toBe('BrowserType')
    expect(BrowserPressTool.name).toBe('BrowserPress')
    expect(BrowserScrollTool.name).toBe('BrowserScroll')
    expect(BrowserScreenshotTool.name).toBe('BrowserScreenshot')
    expect(BrowserHistoryTool.name).toBe('BrowserHistory')
    expect(BrowserCloseTool.name).toBe('BrowserClose')
    expect(BrowserListTasksTool.name).toBe('BrowserListTasks')
    expect(BrowserListTabsTool.name).toBe('BrowserListTabs')
    expect(BrowserListSessionsTool.name).toBe('BrowserListSessions')
  })

  test('read-only markers', () => {
    for (const tool of [
      BrowserGetStateTool,
      BrowserScreenshotTool,
      BrowserListTasksTool,
      BrowserListTabsTool,
      BrowserListSessionsTool,
    ]) {
      expect(tool.isReadOnly()).toBe(true)
      expect(tool.isConcurrencySafe()).toBe(true)
    }
    for (const tool of [
      BrowserAttachTool,
      BrowserNavigateTool,
      BrowserClickTool,
      BrowserTypeTool,
      BrowserPressTool,
      BrowserScrollTool,
      BrowserHistoryTool,
      BrowserCloseTool,
    ]) {
      expect(tool.isReadOnly()).toBe(false)
      expect(tool.isConcurrencySafe()).toBe(false)
    }
  })

  test('non-read-only tools ask for permission, read-only allow', async () => {
    const ask = await BrowserNavigateTool.checkPermissions({
      url: 'https://example.com',
    } as any)
    expect(ask.behavior).toBe('ask')
    const allow = await BrowserGetStateTool.checkPermissions({} as any)
    expect(allow.behavior).toBe('allow')
  })
})

describe('BrowserTools call semantics', () => {
  test('navigate resolves scope from first user message and defaults taskId', async () => {
    const result = await BrowserNavigateTool.call(
      { url: 'https://example.com' } as any,
      ctx,
    )
    const nav = fake.calls.find(c => c.method === 'navigate')
    expect(nav).toBeDefined()
    expect((nav!.args as { url: string }).url).toBe('https://example.com')
    expect((nav!.args as { taskId: string }).taskId).toBe('main')
    expect((nav!.args as { sessionTitle: string }).sessionTitle).toContain(
      '帮我打开 example.com',
    )
    expect(result.data.data.url).toBe('https://example.com')
  })

  test('attach passes explicit tabId', async () => {
    await BrowserAttachTool.call({ tabId: 7 } as any, ctx)
    const attach = fake.calls.find(c => c.method === 'attach')
    expect((attach!.args as { tabId: number | null }).tabId).toBe(7)
  })

  test('click/type/press forward their arguments', async () => {
    await BrowserClickTool.call({ ref: 's1:0' } as any, ctx)
    await BrowserTypeTool.call({ ref: 's1:1', text: 'hi' } as any, ctx)
    await BrowserPressTool.call({ key: 'Enter' } as any, ctx)
    const click = fake.calls.find(c => c.method === 'page.click')
    const type = fake.calls.find(c => c.method === 'page.type')
    const press = fake.calls.find(c => c.method === 'page.press')
    expect((click!.args as { ref: string }).ref).toBe('s1:0')
    expect((type!.args as { text: string }).text).toBe('hi')
    expect((press!.args as { key: string }).key).toBe('Enter')
  })

  test('scroll direction up produces negative y', async () => {
    await BrowserScrollTool.call({ direction: 'up' } as any, ctx)
    const scroll = fake.calls.find(c => c.method === 'page.scroll')
    expect((scroll!.args as { y: number }).y).toBeLessThan(0)
  })

  test('history maps actions to tab methods', async () => {
    await BrowserHistoryTool.call({ action: 'back' } as any, ctx)
    await BrowserHistoryTool.call({ action: 'forward' } as any, ctx)
    await BrowserHistoryTool.call({ action: 'reload' } as any, ctx)
    const methods = fake.calls
      .filter(c => c.method.startsWith('tabs.'))
      .map(c => c.method)
    expect(methods).toEqual(['tabs.back', 'tabs.forward', 'tabs.reload'])
  })

  test('close forwards taskId', async () => {
    await BrowserCloseTool.call({ taskId: 'side' } as any, ctx)
    const close = fake.calls.find(c => c.method === 'close')
    expect((close!.args as { taskId: string }).taskId).toBe('side')
  })

  test('listTasks returns session-scoped items', async () => {
    const result = await BrowserListTasksTool.call({} as any, ctx)
    expect(result.data.items).toHaveLength(1)
    const listed = fake.calls.find(c => c.method === 'listTasks')
    expect((listed!.args as { sessionId: string }).sessionId).toBeTruthy()
  })
})

describe('BrowserScreenshotTool', () => {
  test('returns image output with base64 and media type', async () => {
    const result = await BrowserScreenshotTool.call({} as any, ctx)
    expect(result.data.kind).toBe('image')
    expect(result.data.base64).toBe('aGVsbG8=')
    expect(result.data.mediaType).toBe('image/jpeg')
  })

  test('oversized screenshot throws MESSAGE_TOO_LARGE', async () => {
    fake.screenshotBase64 = 'A'.repeat(8 * 1024 * 1024 + 1)
    let caught: { code?: string } | undefined
    try {
      await BrowserScreenshotTool.call({} as any, ctx)
    } catch (error) {
      caught = error as { code?: string }
    }
    expect(caught?.code).toBe('MESSAGE_TOO_LARGE')
    fake.screenshotBase64 = 'aGVsbG8='
  })
})

describe('resolveBrowserScope / mapBrowserOutput', () => {
  test('falls back to session-id title without user messages', () => {
    const scope = resolveBrowserScope({
      agentId: 'agent123',
      messages: [],
    } as any)
    expect(scope.sessionId).toBe('agent123')
    expect(scope.sessionTitle).toContain('会话 ')
  })

  test('image output maps to text + image blocks', () => {
    const block = mapBrowserOutput(
      { kind: 'image', text: 'shot', base64: 'aGk=', mediaType: 'image/jpeg' },
      'tid',
    )
    const content = block.content as {
      type: string
      source?: { type: string; data: string; media_type: string }
    }[]
    expect(content[0].type).toBe('text')
    expect(content[1].type).toBe('image')
    expect(content[1].source?.media_type).toBe('image/jpeg')
  })

  test('data output maps to JSON string', () => {
    const block = mapBrowserOutput({ kind: 'data', data: { ok: true } }, 'tid')
    expect(block.content).toBe('{\n  "ok": true\n}')
  })
})
