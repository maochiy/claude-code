import type { AgentSessionMeta } from '@proma/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { openTab, type TabItem } from '@/atoms/tab-atoms'

export interface ExternalAgentRunTab {
  id: string
  type: TabItem['type']
  sessionId: string
  title: string
}

export interface ExternalAgentRunActivationInput {
  tabs: ExternalAgentRunTab[]
  sessions: AgentSessionMeta[]
  sessionId: string
  title?: string
  workspaceId?: string
  modelId?: string
  startedAt: number
  currentStreamState?: AgentStreamState
}

export interface ExternalAgentRunActivation {
  tabs: ExternalAgentRunTab[]
  activeTabId: string
  title: string
  workspaceId?: string
  modelId?: string
  streamState: AgentStreamState
}

export function buildExternalAgentRunActivation(
  input: ExternalAgentRunActivationInput,
): ExternalAgentRunActivation {
  const session = input.sessions.find((item) => item.id === input.sessionId)
  const title = input.title ?? session?.title ?? '新 Agent 会话'
  const nextTab = openTab(input.tabs, { type: 'agent', sessionId: input.sessionId, title })
  const tabs = nextTab.tabs
  const activeTabId = nextTab.activeTabId

  return {
    tabs,
    activeTabId,
    title,
    workspaceId: input.workspaceId ?? session?.workspaceId,
    modelId: input.modelId,
    streamState: {
      ...input.currentStreamState,
      running: true,
      content: input.currentStreamState?.content ?? '',
      toolActivities: input.currentStreamState?.toolActivities ?? [],
      model: input.modelId ?? input.currentStreamState?.model,
      startedAt: input.startedAt,
    },
  }
}
