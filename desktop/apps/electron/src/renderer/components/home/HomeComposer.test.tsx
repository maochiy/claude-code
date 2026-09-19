import { describe, expect, mock, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentRuntimeModelCatalog, AgentWorkspace, PromaPermissionMode } from '@proma/shared'
import { appModeAtom } from '@/atoms/app-mode'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentRuntimeModelCatalogsAtom,
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  getAgentRuntimeModelCatalogKey,
  homeAgentPermissionModeAtom,
} from '@/atoms/agent-atoms'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'

const WORKSPACE: AgentWorkspace = {
  id: 'project-a',
  name: 'Proma',
  slug: 'proma',
  path: '/projects/proma',
  canonicalPath: '/projects/proma',
  createdAt: 1,
  updatedAt: 1,
}

function ensureTestGlobals(): void {
  const storage = new Map<string, string>()
  if (typeof globalThis.localStorage === 'undefined') {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
        clear: () => storage.clear(),
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        get length() { return storage.size },
      },
    })
  }

  if (typeof globalThis.window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    })
  }

  Reflect.set(globalThis.window, 'electronAPI', {
    listChannels: async () => [],
    updateSettings: async () => ({}),
    createAgentWorkspace: async () => null,
  })
}

ensureTestGlobals()
const {
  HomeComposer,
  getHomePermissionDescriptionKey,
  getHomePermissionModes,
  saveHomeAgentAttachments,
  saveHomeChatAttachments,
} = await import('./HomeComposer')

function runtimeCatalog(supportsAutoMode: boolean): AgentRuntimeModelCatalog {
  return {
    channelId: 'channel-a',
    defaultModel: 'model-a',
    models: [{
      value: 'model-a',
      displayName: 'Model A',
      description: '',
      contextWindow: 200_000,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      defaultEffortLevel: 'medium',
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
      supportsAutoMode,
    }],
    contextPolicy: { autoCompactEnabled: true, models: [] },
  }
}

function renderComposer(
  mode: 'chat' | 'agent',
  workspaceId: string | null = null,
  permissionMode: PromaPermissionMode = 'default',
  supportsAutoMode?: boolean,
): string {
  const store = createStore()
  store.set(appModeAtom, mode)
  store.set(agentWorkspacesAtom, [WORKSPACE])
  store.set(currentAgentWorkspaceIdAtom, workspaceId)
  store.set(homeAgentPermissionModeAtom, permissionMode)
  store.set(agentChannelIdAtom, 'channel-a')
  store.set(agentModelIdAtom, 'model-a')
  if (supportsAutoMode !== undefined) {
    store.set(agentRuntimeModelCatalogsAtom, new Map([
      [getAgentRuntimeModelCatalogKey(workspaceId, 'channel-a'), runtimeCatalog(supportsAutoMode)],
    ]))
  }
  store.set(settingsPreferencesAtom, (current) => ({ ...current, interfaceLanguage: 'en' }))

  return renderToStaticMarkup(
    <Provider store={store}>
      <HomeComposer />
    </Provider>,
  )
}

describe('主页输入区', () => {
  test('Given Code 主页 When 渲染输入框 Then 显示 Local、项目入口、Effort 档位徽章触发器和工具行', () => {
    const html = renderComposer('agent', WORKSPACE.id)

    expect(html).toContain('data-home-composer')
    expect(html).toContain('Local')
    expect(html).toContain('Proma')
    expect(html).toContain('Manual')
    expect(html).toContain('Describe a task or ask a question')
    expect(html).toContain('Thinking level:')
    expect(html).not.toContain('!rounded-xl')
    expect(getHomePermissionModes(true)).toEqual([
      'default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions', 'auto',
    ])
  })

  test('Given 首页选择不询问 When 渲染 Code 输入区 Then 保留原生 dontAsk 而不降级', () => {
    const html = renderComposer('agent', WORKSPACE.id, 'dontAsk')

    expect(html).toContain("Approval mode：Don&#x27;t ask")
    expect(html).not.toContain('Approval mode：Bypass permissions')
  })

  test('Given 首页选择 Plan When 渲染 Code 输入区 Then 触发器显示独立计划模式', () => {
    const html = renderComposer('agent', WORKSPACE.id, 'plan')

    expect(html).toContain('aria-label="Approval mode：Plan"')
  })

  test('Given Runtime 模型能力 When 构建 Auto 入口 Then 支持时可选且不可用原因使用当前语言键', () => {
    const html = renderComposer('agent', WORKSPACE.id, 'auto', true)

    expect(html).toContain('aria-label="Approval mode：Auto"')
    expect(getHomePermissionDescriptionKey('auto', 'supported')).toBe('permission.autoDescription')
    expect(getHomePermissionDescriptionKey('auto', 'checking')).toBe('permission.autoChecking')
    expect(getHomePermissionDescriptionKey('auto', 'unsupported')).toBe('permission.autoUnavailable')
  })

  test('Given 参考截图工具行 When 审批为 acceptEdits Then chip 显示 Accept edits 纯文字 + 裸加号而非 v 箭头', () => {
    const html = renderComposer('agent', WORKSPACE.id, 'acceptEdits')

    expect(html).toContain('aria-label="Approval mode：Accept edits"')
    expect(html).not.toContain('polyline')
  })

  test('Given Cowork 主页 When 渲染输入框 Then 保留大圆角输入卡且不显示 Effort', () => {
    const html = renderComposer('chat')

    expect(html).toContain('Local')
    expect(html).toContain('!rounded-[22px]')
    expect(html).toContain('aria-label="Add attachment"')
    expect(html).not.toContain('Attachments are coming soon')
    expect(html).toContain('aria-label="Send and start a new session"')
    expect(html).toContain('Describe a task or ask a question')
    expect(html).not.toContain('Accept edits')
    expect(html).not.toContain('当前项目')
    expect(html).not.toContain('Faster')
  })

  test('Given 首页选择图片和文档 When Chat 会话创建成功 Then 使用现有附件服务绑定到新会话', async () => {
    const saveAttachment = mock(async (input: {
      conversationId: string
      filename: string
      mediaType: string
      data: string
    }) => ({
      attachment: {
        id: `saved-${input.filename}`,
        filename: input.filename,
        mediaType: input.mediaType,
        localPath: `${input.conversationId}/${input.filename}`,
        size: 4,
      },
    }))

    const saved = await saveHomeChatAttachments('conversation-new', [{
      id: 'pending-image',
      filename: 'screen.png',
      mediaType: 'image/png',
      size: 4,
      data: 'AAAA',
      previewUrl: 'data:image/png;base64,AAAA',
    }], { saveAttachment })

    expect(saveAttachment).toHaveBeenCalledWith({
      conversationId: 'conversation-new',
      filename: 'screen.png',
      mediaType: 'image/png',
      data: 'AAAA',
    })
    expect(saved[0]?.localPath).toBe('conversation-new/screen.png')
  })

  test('Given 首页选择文档 When Code 会话创建成功 Then 保存到该会话并生成发送队列附件', async () => {
    const saveFilesToAgentSession = mock(async () => [{
      filename: 'spec.pdf',
      targetPath: '/projects/proma/.zcode/session-new/spec.pdf',
    }])

    const saved = await saveHomeAgentAttachments({
      workspaceSlug: 'proma',
      sessionId: 'session-new',
      attachments: [{
        id: 'pending-document',
        filename: 'spec.pdf',
        mediaType: 'application/pdf',
        size: 4,
        data: 'AAAA',
      }],
      api: { saveFilesToAgentSession },
    })

    expect(saveFilesToAgentSession).toHaveBeenCalledWith({
      workspaceSlug: 'proma',
      sessionId: 'session-new',
      files: [{ filename: 'spec.pdf', data: 'AAAA' }],
    })
    expect(saved).toEqual([{
      filename: 'spec.pdf',
      targetPath: '/projects/proma/.zcode/session-new/spec.pdf',
      mediaType: 'application/pdf',
      size: 4,
    }])
  })
})
