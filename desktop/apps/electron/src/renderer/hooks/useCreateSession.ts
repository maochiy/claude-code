/**
 * useCreateSession — 共享的创建 Chat 对话 / Agent 会话逻辑
 *
 * 从 LeftSidebar 提取，供主页输入区和侧边栏共同使用。
 */

import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type {
  AgentSessionGitContext,
  AgentSessionMeta,
  ConversationMeta,
  PromaPermissionMode,
} from '@proma/shared'
import {
  conversationsAtom,
  selectedModelAtom,
} from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { promptConfigAtom, selectedPromptIdAtom } from '@/atoms/system-prompt-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { upsertAgentSession } from '@/lib/agent-session-list'
import { useOpenSession } from './useOpenSession'

interface CreateSessionOptions {
  /** 标记为草稿会话（不在侧边栏显示，发送首条消息后自动取消） */
  draft?: boolean
  /** 覆盖默认渠道 ID（仅 Agent 会话） */
  channelId?: string
  /** 覆盖默认模型 ID（仅 Agent 会话） */
  modelId?: string
  /** 覆盖默认工作区 ID（仅 Agent 会话） */
  workspaceId?: string
  /** 新 Code 会话的 Git 分支与 worktree 选择。 */
  gitContext?: AgentSessionGitContext
  /** 新 Code 会话首次运行使用的原生权限模式。 */
  permissionMode?: PromaPermissionMode
  /** 会话进入列表与页面前完成附件等首轮资源绑定。 */
  prepareChat?: (meta: ConversationMeta) => Promise<void>
  /** 会话进入列表与页面前完成附件等首轮资源绑定。 */
  prepareAgent?: (meta: AgentSessionMeta) => Promise<void>
}

interface CreateSessionActions {
  /** 创建新 Chat 对话并打开标签页 */
  createChat: (options?: CreateSessionOptions) => Promise<string | undefined>
  /** 创建新 Agent 会话并打开标签页 */
  createAgent: (options?: CreateSessionOptions) => Promise<string | undefined>
}

interface InitialAgentSessionModeApi {
  updateSessionPermissionMode: (sessionId: string, mode: PromaPermissionMode) => Promise<void>
  updateSessionPlanMode: (sessionId: string, enabled: boolean) => Promise<void>
}

/**
 * 在会话进入 Renderer、首条消息进入自动发送队列前固化原生模式。
 * Plan 使用独立持久化开关；其它五种模式直接写入 permissionMode。
 */
export async function applyInitialAgentSessionMode(
  meta: AgentSessionMeta,
  mode: PromaPermissionMode | undefined,
  api: InitialAgentSessionModeApi,
): Promise<AgentSessionMeta> {
  if (!mode) return meta
  if (mode === 'plan') {
    await api.updateSessionPlanMode(meta.id, true)
    return { ...meta, permissionMode: 'default', planModeEnabled: true }
  }
  await api.updateSessionPermissionMode(meta.id, mode)
  return { ...meta, permissionMode: mode, planModeEnabled: false }
}

export function useCreateSession(): CreateSessionActions {
  const openSession = useOpenSession()
  const setActiveView = useSetAtom(activeViewAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)

  // Chat
  const setConversations = useSetAtom(conversationsAtom)
  const selectedModel = useAtomValue(selectedModelAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom)

  // Agent
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)

  const createChat = async (options?: CreateSessionOptions): Promise<string | undefined> => {
    let createdId: string | undefined
    try {
      const meta = await window.electronAPI.createConversation(
        undefined,
        selectedModel?.modelId,
        selectedModel?.channelId,
      )
      createdId = meta.id
      await options?.prepareChat?.(meta)
      setConversations((prev) => [meta, ...prev])
      openSession('chat', meta.id, meta.title)
      setActiveView('conversations')
      if (promptConfig.defaultPromptId) {
        setSelectedPromptId(promptConfig.defaultPromptId)
      }
      if (options?.draft) {
        setDraftSessionIds((prev: Set<string>) => { const next = new Set(prev); next.add(meta.id); return next })
      }
      return meta.id
    } catch (error) {
      if (createdId) {
        await window.electronAPI.deleteConversation(createdId).catch(() => {})
      }
      console.error('[创建会话] 创建 Chat 对话失败:', error)
      toast.error(error instanceof Error ? error.message : '创建协作会话失败')
      return undefined
    }
  }

  const createAgent = async (options?: CreateSessionOptions): Promise<string | undefined> => {
    let createdId: string | undefined
    try {
      const createdMeta = await window.electronAPI.createAgentSession(
        undefined,
        options?.channelId ?? agentChannelId ?? undefined,
        options?.workspaceId ?? currentWorkspaceId ?? undefined,
        options?.modelId ?? agentModelId ?? undefined,
        options?.draft === true,
        undefined,
        options?.gitContext,
      )
      createdId = createdMeta.id
      const meta = await applyInitialAgentSessionMode(
        createdMeta,
        options?.permissionMode,
        window.electronAPI,
      )
      await options?.prepareAgent?.(meta)
      setAgentSessions((prev) => upsertAgentSession(prev, meta))
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
      if (options?.draft) {
        setDraftSessionIds((prev: Set<string>) => { const next = new Set(prev); next.add(meta.id); return next })
      }
      return meta.id
    } catch (error) {
      if (createdId) {
        await window.electronAPI.deleteAgentSession(createdId).catch(() => {})
      }
      console.error('[创建会话] 创建 Agent 会话失败:', error)
      toast.error(error instanceof Error ? error.message : '创建 Code 会话失败')
      return undefined
    }
  }

  return { createChat, createAgent }
}
