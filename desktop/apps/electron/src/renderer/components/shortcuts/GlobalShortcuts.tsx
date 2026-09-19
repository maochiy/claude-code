/**
 * GlobalShortcuts — 全局快捷键注册 + 初始化组件
 *
 * 在 main.tsx 顶层挂载（类似 AgentListenersInitializer），永不销毁。
 * 负责：
 * 1. 初始化快捷键注册表
 * 2. 从 settings 加载用户自定义配置
 * 3. 注册所有应用级快捷键的 handler
 * 4. 监听菜单 IPC 事件（Cmd+W 关闭标签）
 */

import { useEffect, useCallback } from 'react'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import type { QuickTaskRecoveryStageInput } from '../../../types'
import { appModeAtom } from '@/atoms/app-mode'
import { settingsOpenAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from '@/atoms/settings-tab'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import {
  tabsAtom,
  activeTabIdAtom,
  sidebarCollapsedAtom,
  openTab,
} from '@/atoms/tab-atoms'
import { shortcutOverridesAtom, sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import {
  agentPendingPromptAtom,
  agentSessionDraftHtmlAtom,
  agentSessionDraftsAtom,
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedFilesMapAtom,
  agentQuickTaskRecoveryDraftsAtom,
} from '@/atoms/agent-atoms'
import {
  chatPendingMessageAtom,
  conversationDraftsAtom,
  conversationsAtom,
  currentConversationIdAtom,
  selectedModelAtom,
  chatQuickTaskRecoveryDraftsAtom,
} from '@/atoms/chat-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { useShortcut } from '@/hooks/useShortcut'
import { useCloseTab } from '@/hooks/useCloseTab'
import { useGoHomeLanding } from '@/hooks/useGoHomeLanding'
import {
  initShortcutRegistry,
  updateShortcutOverrides,
} from '@/lib/shortcut-registry'
import { getFileParentPath } from '@/lib/file-utils'
import { upsertAgentSession } from '@/lib/agent-session-list'

/**
 * 快捷键初始化 + 全局 Handler 注册
 *
 * 挂载后从 settings 加载自定义配置，并注册所有应用级快捷键。
 */
export function GlobalShortcuts(): null {
  const [appMode, setAppMode] = useAtom(appModeAtom)
  const [settingsOpen, setSettingsOpen] = useAtom(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const [searchOpen, setSearchOpen] = useAtom(searchDialogOpenAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const goHomeLanding = useGoHomeLanding()

  // Tab 管理（用于关闭标签页）
  const activeTabId = useAtomValue(activeTabIdAtom)

  // 统一关闭逻辑：与 TabBar.handleClose 共用
  // 含 Agent 子进程 stop + 流式中的确认对话框（修复 Issue #357）
  const { requestClose } = useCloseTab()

  // 初始化：挂载注册表 + 加载用户配置
  useEffect(() => {
    initShortcutRegistry()

    window.electronAPI.getSettings().then((settings) => {
      if (settings.shortcutOverrides) {
        setShortcutOverrides(settings.shortcutOverrides)
        updateShortcutOverrides(settings.shortcutOverrides)
      }
      setSendWithCmdEnter(settings.sendWithCmdEnter ?? false)
    }).catch(console.error)
  }, [setShortcutOverrides, setSendWithCmdEnter])

  // 配置变更时同步到注册表
  useEffect(() => {
    updateShortcutOverrides(shortcutOverrides)
  }, [shortcutOverrides])

  // ===== 关闭标签页逻辑 =====

  const handleCloseTab = useCallback(() => {
    // 浮窗优先：有浮窗打开时 Cmd+W 先关闭浮窗而非 tab
    if (settingsOpen) {
      // 渠道表单有未保存内容时，通知 SettingsModal 弹出确认对话框
      if (channelFormDirty) {
        setSettingsCloseRequested(true)
        return
      }
      setSettingsOpen(false)
      return
    }
    if (searchOpen) {
      setSearchOpen(false)
      return
    }

    if (!activeTabId) return
    requestClose(activeTabId)
  }, [settingsOpen, setSettingsOpen, channelFormDirty, setSettingsCloseRequested, searchOpen, setSearchOpen, activeTabId, requestClose])

  // 监听菜单 IPC 事件（Cmd+W 被 Electron 菜单拦截后通过 IPC 转发）
  useEffect(() => {
    const cleanup = window.electronAPI.onMenuCloseTab(handleCloseTab)
    return cleanup
  }, [handleCloseTab])

  // 同时注册到快捷键系统（用于设置面板展示和自定义，实际触发走 IPC）
  useShortcut('close-tab', handleCloseTab)

  // ===== 快捷键 Handler =====

  // Cmd+, → 打开设置
  useShortcut(
    'open-settings',
    useCallback(() => setSettingsOpen(true), [setSettingsOpen]),
  )

  // Cmd+Shift+F / Ctrl+Shift+F → 全局搜索
  useShortcut(
    'global-search',
    useCallback(() => setSearchOpen(true), [setSearchOpen]),
  )

  // Cmd+N → 回到主页空态，由 HomeComposer 提交时再创建会话
  useShortcut(
    'new-session',
    useCallback(() => {
      goHomeLanding()
    }, [goHomeLanding]),
  )

  // Cmd+B → 切换侧边栏
  useShortcut(
    'toggle-sidebar',
    useCallback(
      () => setSidebarCollapsed(!sidebarCollapsed),
      [sidebarCollapsed, setSidebarCollapsed],
    ),
  )

  // Cmd+Shift+M → 切换模式
  useShortcut(
    'toggle-mode',
    useCallback(
      () => { if (appMode !== 'scratch') setAppMode(appMode === 'chat' ? 'agent' : 'chat') },
      [appMode, setAppMode],
    ),
  )

  // Cmd+K → 清除上下文（通过 CustomEvent 分发到 ChatInput）
  useShortcut(
    'clear-context',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('proma:clear-context'))
    }, []),
  )

  // Cmd+L → 聚焦输入框（通过 CustomEvent 分发到 ChatInput/AgentView）
  useShortcut(
    'focus-input',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('proma:focus-input'))
    }, []),
  )

  // Cmd+Shift+Backspace → 停止 Agent（通过 CustomEvent 分发到 ChatView/AgentView）
  useShortcut(
    'stop-generation',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('proma:stop-generation'))
    }, []),
  )

  // ===== 快速任务窗口 → 创建会话并自动发送 =====

  const store = useStore()

  // Renderer 在 Main 已接收后崩溃时，只恢复为可见草稿并提示用户确认。
  // 这里故意不写入 pending atom，避免无法判断是否已经发出的任务被自动重放。
  useEffect(() => {
    let cancelled = false
    window.electronAPI.listQuickTaskRecoveries()
      .then((records) => {
        if (cancelled || records.length === 0) return
        for (const record of records) {
          if (record.mode === 'agent') {
            store.set(agentSessionDraftsAtom, (previous) => {
              if (previous.has(record.sessionId)) return previous
              const next = new Map(previous)
              next.set(record.sessionId, record.message)
              return next
            })
            store.set(agentSessionDraftHtmlAtom, (previous) => {
              if (!previous.has(record.sessionId)) return previous
              const next = new Map(previous)
              next.delete(record.sessionId)
              return next
            })
            store.set(agentQuickTaskRecoveryDraftsAtom, (previous) => {
              const next = new Map(previous)
              next.set(record.sessionId, {
                submissionId: record.submissionId,
                message: record.message,
                attachments: record.attachments?.map(attachment => ({
                  filename: attachment.filename,
                  mediaType: attachment.mediaType,
                  sourcePath: attachment.sourcePath,
                })),
                additionalDirectories: record.additionalDirectories,
              })
              return next
            })
          } else {
            store.set(conversationDraftsAtom, (previous) => {
              if (previous.has(record.sessionId)) return previous
              const next = new Map(previous)
              next.set(record.sessionId, record.message)
              return next
            })
            const attachments = record.attachments
              ?.flatMap(reference => reference.attachment ? [reference.attachment] : []) ?? []
            store.set(chatQuickTaskRecoveryDraftsAtom, (previous) => {
              const next = new Map(previous)
              next.set(record.sessionId, {
                submissionId: record.submissionId,
                message: record.message,
                attachments,
              })
              return next
            })
          }
        }
        const attachmentCount = records.reduce((count, record) => count + (record.attachments?.length ?? 0), 0)
        toast.warning(`已恢复 ${records.length} 条快速任务草稿`, {
          description: attachmentCount > 0
            ? `保留了 ${attachmentCount} 个附件引用。任务可能已经发送，请检查会话后再决定是否重发。`
            : '任务可能已经发送，请检查会话后再决定是否重发。',
          duration: 10_000,
        })
      })
      .catch((error) => console.error('[快速任务] 恢复草稿失败:', error))
    return () => { cancelled = true }
  }, [store])

  useEffect(() => {
    const cleanup = window.electronAPI.onQuickTaskOpenSession(async (data) => {
      let createdSession: { mode: 'chat' | 'agent'; id: string } | undefined
      let commitPrepared: (() => void) | undefined
      let recoveryStage: QuickTaskRecoveryStageInput | undefined
      let claimResolved = false
      let claimGranted = false
      try {
        if (data.mode === 'agent') {
          // Agent 模式：创建会话 + 保存附件到 session 目录
          const channelId = store.get(agentChannelIdAtom) || undefined
          const modelId = store.get(agentModelIdAtom) || undefined
          const workspaceId = store.get(currentAgentWorkspaceIdAtom) || undefined
          const meta = await window.electronAPI.createAgentSession(
            undefined,
            channelId,
            workspaceId,
            modelId,
          )
          createdSession = { mode: 'agent', id: meta.id }

          // 处理附件：保存到 session 目录，构建 file references
          let fileReferences = ''
          let preparedAttachedFiles: Awaited<ReturnType<typeof window.electronAPI.attachFile>> | undefined
          let preparedAttachmentReferences: QuickTaskRecoveryStageInput['attachments']
          const additionalDirectories = new Set<string>()
          if (data.files && data.files.length > 0) {
            if (!workspaceId) throw new Error('当前未选择项目，无法保存 Agent 附件')
            const workspaces = store.get(agentWorkspacesAtom)
            const workspace = workspaces.find((w) => w.id === workspaceId)
            if (!workspace) throw new Error('当前项目不存在，无法保存 Agent 附件')
            const allRefs: Array<{ filename: string; targetPath: string }> = []
            for (const file of data.files) {
              if (!file.sourcePath) continue
              preparedAttachedFiles = await window.electronAPI.attachFile({
                sessionId: meta.id,
                filePath: file.sourcePath,
              })
              allRefs.push({ filename: file.filename, targetPath: file.sourcePath })
              const parentPath = getFileParentPath(file.sourcePath)
              if (parentPath) additionalDirectories.add(parentPath)
            }

            const filesToSave = data.files.filter((f) => f.base64).map((f) => ({
              filename: f.filename,
              data: f.base64!,
            }))
            if (filesToSave.length > 0) {
              const saved = await window.electronAPI.saveFilesToAgentSession({
                workspaceSlug: workspace.slug,
                sessionId: meta.id,
                files: filesToSave,
              })
              allRefs.push(...saved)
            }

            if (allRefs.length > 0) {
              const refs = allRefs.map((f) => `- ${f.filename}: ${f.targetPath}`).join('\n')
              fileReferences = `<attached_files>\n${refs}\n</attached_files>\n\n`
              preparedAttachmentReferences = allRefs.map((file) => ({
                filename: file.filename,
                mediaType: data.files?.find(source => source.filename === file.filename)?.mediaType,
                size: data.files?.find(source => source.filename === file.filename)?.size,
                sourcePath: file.targetPath,
              }))
            }
          }

          recoveryStage = {
            requestId: data.requestId,
            submissionId: data.submissionId,
            mode: 'agent',
            sessionId: meta.id,
            title: data.text.slice(0, 30),
            message: data.text,
            attachments: preparedAttachmentReferences,
            ...(additionalDirectories.size > 0 && { additionalDirectories: Array.from(additionalDirectories) }),
          }

          commitPrepared = (): void => {
            store.set(appModeAtom, 'agent')
            store.set(activeViewAtom, 'conversations')
            store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, meta))
            store.set(currentAgentSessionIdAtom, meta.id)
            if (preparedAttachedFiles) {
              store.set(agentAttachedFilesMapAtom, (prev) => {
                const map = new Map(prev)
                map.set(meta.id, preparedAttachedFiles!)
                return map
              })
            }
            const result = openTab(store.get(tabsAtom), {
              type: 'agent',
              sessionId: meta.id,
              title: data.text.slice(0, 30),
            })
            store.set(tabsAtom, result.tabs)
            store.set(activeTabIdAtom, result.activeTabId)
            store.set(agentPendingPromptAtom, {
              sessionId: meta.id,
              message: fileReferences + data.text,
              ...(additionalDirectories.size > 0 && { additionalDirectories: Array.from(additionalDirectories) }),
              quickTaskSubmissionId: data.submissionId,
            })
          }
        } else {
          // Chat 模式：创建对话 + 保存附件到磁盘
          const chatModel = store.get(selectedModelAtom)
          const meta = await window.electronAPI.createConversation(
            undefined,
            chatModel?.modelId,
            chatModel?.channelId,
          )
          createdSession = { mode: 'chat', id: meta.id }

          // 处理附件：保存到磁盘，收集 FileAttachment[]
          const savedAttachments: import('@proma/shared').FileAttachment[] = []
          if (data.files && data.files.length > 0) {
            for (const file of data.files) {
              if (!file.base64) {
                throw new Error(`Chat 附件缺少内容：${file.filename}`)
              }
              const result = await window.electronAPI.saveAttachment({
                conversationId: meta.id,
                filename: file.filename,
                mediaType: file.mediaType,
                data: file.base64,
              })
              savedAttachments.push(result.attachment)
            }
          }

          recoveryStage = {
            requestId: data.requestId,
            submissionId: data.submissionId,
            mode: 'chat',
            sessionId: meta.id,
            title: data.text.slice(0, 30),
            message: data.text,
            attachments: savedAttachments.map((attachment) => ({
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              size: attachment.size,
              attachment,
            })),
          }

          commitPrepared = (): void => {
            store.set(appModeAtom, 'chat')
            store.set(activeViewAtom, 'conversations')
            store.set(conversationsAtom, (prev) => [meta, ...prev])
            store.set(currentConversationIdAtom, meta.id)
            const tabResult = openTab(store.get(tabsAtom), {
              type: 'chat',
              sessionId: meta.id,
              title: data.text.slice(0, 30),
            })
            store.set(tabsAtom, tabResult.tabs)
            store.set(activeTabIdAtom, tabResult.activeTabId)
            store.set(chatPendingMessageAtom, {
              conversationId: meta.id,
              message: data.text,
              attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
              quickTaskSubmissionId: data.submissionId,
            })
          }
        }

        if (!recoveryStage) throw new Error('快速任务恢复草稿准备失败')
        await window.electronAPI.stageQuickTaskRecovery(recoveryStage)
        const claim = await window.electronAPI.claimQuickTaskOpenSession({
          requestId: data.requestId,
          submissionId: data.submissionId,
          prepared: true,
        })
        claimResolved = true
        if (!claim.commit) throw new Error(claim.error || '快速任务提交许可已过期')
        claimGranted = true
        commitPrepared?.()
        createdSession = undefined
      } catch (error) {
        console.error('[快速任务] 创建会话失败:', error)
        if (!claimGranted && createdSession?.mode === 'agent') {
          await window.electronAPI.deleteAgentSession(createdSession.id).catch(() => undefined)
        } else if (!claimGranted && createdSession) {
          await window.electronAPI.deleteConversation(createdSession.id).catch(() => undefined)
        }
        if (!claimGranted) {
          await window.electronAPI.clearQuickTaskRecovery({
            submissionId: data.submissionId,
            requestId: data.requestId,
          }).catch(() => undefined)
        }
        if (!claimResolved) {
          await window.electronAPI.claimQuickTaskOpenSession({
            requestId: data.requestId,
            submissionId: data.submissionId,
            prepared: false,
            error: error instanceof Error ? error.message : '主窗口处理快速任务失败',
          }).catch(() => undefined)
        }
      }
    })
    return cleanup
  }, [store])

  // ===== 语音输入 → 写入当前 Proma 输入框 =====

  useEffect(() => {
    const cleanup = window.electronAPI.onVoiceDictationInsertText(({ text }) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const insertedAtCursor = !window.dispatchEvent(new CustomEvent('proma:insert-voice-dictation-text', {
        cancelable: true,
        detail: { text: trimmed },
      }))
      if (insertedAtCursor) {
        window.dispatchEvent(new CustomEvent('proma:focus-input'))
        return
      }

      const tabs = store.get(tabsAtom)
      const activeTabId = store.get(activeTabIdAtom)
      const activeTab = tabs.find((tab) => tab.id === activeTabId)
      const currentMode = store.get(appModeAtom)
      const fallbackTarget =
        currentMode === 'agent'
          ? { type: 'agent' as const, sessionId: store.get(currentAgentSessionIdAtom) }
          : { type: 'chat' as const, sessionId: store.get(currentConversationIdAtom) }
      const target = activeTab ?? fallbackTarget

      if (!target.sessionId) return

      store.set(activeViewAtom, 'conversations')

      if (target.type === 'agent') {
        const sessionId = target.sessionId
        store.set(appModeAtom, 'agent')
        store.set(currentAgentSessionIdAtom, sessionId)
        store.set(agentSessionDraftsAtom, (prev) => {
          const map = new Map(prev)
          const current = map.get(sessionId) ?? ''
          map.set(sessionId, current ? `${current}\n${trimmed}` : trimmed)
          return map
        })
        store.set(agentSessionDraftHtmlAtom, (prev) => {
          const map = new Map(prev)
          map.delete(sessionId)
          return map
        })
        window.dispatchEvent(new CustomEvent('proma:focus-input'))
        return
      }

      if (target.type === 'chat') {
        const conversationId = target.sessionId
        store.set(appModeAtom, 'chat')
        store.set(currentConversationIdAtom, conversationId)
        store.set(conversationDraftsAtom, (prev) => {
          const map = new Map(prev)
          const current = map.get(conversationId) ?? ''
          map.set(conversationId, current ? `${current}\n${trimmed}` : trimmed)
          return map
        })
        window.dispatchEvent(new CustomEvent('proma:focus-input'))
      }
    })
    return cleanup
  }, [store])

  // ===== 菜单栏 → 打开 / 创建会话 =====

  useEffect(() => {
    const cleanupOpen = window.electronAPI.onTrayOpenAgentSession(async (data) => {
      try {
        const sessions = await window.electronAPI.listAgentSessions()
        const session = sessions.find((item) => item.id === data.sessionId)
        if (!session) return

        store.set(agentSessionsAtom, sessions)
        store.set(appModeAtom, 'agent')
        store.set(activeViewAtom, 'conversations')
        store.set(currentAgentSessionIdAtom, session.id)

        if (session.workspaceId) {
          store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
        }

        const currentTabs = store.get(tabsAtom)
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: session.id,
          title: session.title || data.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
      } catch (error) {
        console.error('[菜单栏] 打开 Agent 会话失败:', error)
      }
    })

    const cleanupCreate = window.electronAPI.onTrayCreateSession((data) => {
      store.set(appModeAtom, data.mode)
      store.set(activeViewAtom, 'conversations')
      goHomeLanding()
    })

    return () => {
      cleanupOpen()
      cleanupCreate()
    }
  }, [store, goHomeLanding])
  return null
}
