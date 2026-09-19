/**
 * Tab Atoms — 当前工作区入口状态管理
 *
 * 主区只保留当前会话入口；无会话时展示主页空态。
 * Scratch Pad 仅在用户主动打开时进入标签列表，不再作为默认落地页。
 * 通过桥接 atom 与现有 currentConversationIdAtom / currentAgentSessionIdAtom 同步，
 * 确保所有现有派生 atoms 无需修改。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  streamingConversationIdsAtom,
} from './chat-atoms'
import {
  agentRunningSessionIdsAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
} from './agent-atoms'
import type { SessionIndicatorStatus } from './agent-atoms'

// ===== 类型定义 =====

/** 标签页类型（Settings 不作为 Tab，保留独立视图） */
export type TabType = 'chat' | 'agent' | 'scratch' | 'tutorial'

/** Scratch Pad 专用的固定 sessionId */
export const SCRATCH_PAD_ID = '__scratch-pad__'

/** 教程 Tab 固定 ID */
export const TUTORIAL_TAB_ID = '__tutorial__'
export const TUTORIAL_TAB_TITLE = 'Xcodes 使用教程'

/** Scratch Pad 标签默认标题 */
export const SCRATCH_PAD_TITLE = 'Scratch Pad'

/** 标签页数据 */
export interface TabItem {
  /** 唯一标签 ID（直接使用 sessionId） */
  id: string
  /** 标签页类型 */
  type: TabType
  /** Chat conversationId 或 Agent sessionId */
  sessionId: string
  /** 标签页显示标题 */
  title: string
}

/** Tab 持久化数据（保存到 settings.json） */
export interface PersistedTabState {
  tabs: TabItem[]
  activeTabId: string | null
}

// ===== 核心 Atoms =====

/** 当前工作区入口列表：当前会话，或用户主动打开的草稿本 */
export const tabsAtom = atom<TabItem[]>([])

/** 当前激活的标签 ID */
export const activeTabIdAtom = atom<string | null>(null)

/** 标签页 MRU（最近使用）顺序，最近使用的 ID 排在前面 */
export const tabMruAtom = atom<string[]>([])

/** 侧边栏是否收起（持久化） */
export const sidebarCollapsedAtom = atomWithStorage<boolean>(
  'proma-sidebar-collapsed',
  false,
)

/** 侧栏收起后的悬停飞出（仅运行期，不持久化） */
export const sidebarPeekingAtom = atom(false)

/** Tab 迷你地图缓存（每个 Tab 的消息预览列表，在消息组件中填充） */
export interface TabMinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
}
export const tabMinimapCacheAtom = atom<Map<string, TabMinimapItem[]>>(new Map())

/** Scratch Pad 编辑内容（HTML 字符串，供 TipTap 编辑器使用） */
export const scratchPadContentAtom = atom<string>('')
/** Scratch Pad 内容是否已从磁盘加载 */
export const scratchPadLoadedAtom = atom<boolean>(false)
/** Scratch Pad 是否固定在 Agent 右侧分屏 */
export const scratchPadPanelOpenAtom = atom<boolean>(false)
/** 右侧工作区中 Preview 与 Scratch 并排时，Preview 占比 */
export const rightWorkspaceSplitRatioAtom = atomWithStorage<number>(
  'proma-right-workspace-split-ratio',
  0.58,
  undefined,
  { getOnInit: true },
)

// ===== 派生 Atoms =====

/** 当前活跃标签 */
export const activeTabAtom = atom<TabItem | null>((get) => {
  const activeId = get(activeTabIdAtom)
  if (!activeId) return null
  return get(tabsAtom).find((t) => t.id === activeId) ?? null
})

/** 当前活跃标签所属的会话 ID。 */
export const activeSessionIdAtom = atom<string | null>((get) => {
  const activeTab = get(activeTabAtom)
  return activeTab?.sessionId ?? null
})

/** 标签是否在流式输出中（派生，从现有流式 atoms 计算） */
export const tabStreamingMapAtom = atom<Map<string, boolean>>((get) => {
  const tabs = get(tabsAtom)
  const chatStreaming = get(streamingConversationIdsAtom)
  const agentRunning = get(agentRunningSessionIdsAtom)
  const map = new Map<string, boolean>()
  for (const tab of tabs) {
    if (tab.type === 'scratch') continue
    if (tab.type === 'chat') {
      map.set(tab.id, chatStreaming.has(tab.sessionId))
    } else if (tab.type === 'agent') {
      map.set(tab.id, agentRunning.has(tab.sessionId))
    }
  }
  return map
})

/** 标签页指示点状态（chat 用 running/idle，agent 用完整 SessionIndicatorStatus） */
export const tabIndicatorMapAtom = atom<Map<string, SessionIndicatorStatus>>((get) => {
  const tabs = get(tabsAtom)
  const chatStreaming = get(streamingConversationIdsAtom)
  const agentIndicator = get(agentSessionIndicatorMapAtom)
  const unviewedCompletedIds = get(unviewedCompletedSessionIdsAtom)
  const map = new Map<string, SessionIndicatorStatus>()
  for (const tab of tabs) {
    if (tab.type === 'scratch') continue
    if (tab.type === 'chat') {
      map.set(tab.id, chatStreaming.has(tab.sessionId) ? 'running' : 'idle')
    } else if (tab.type === 'agent') {
      const status = agentIndicator.get(tab.sessionId)
        ?? (unviewedCompletedIds.has(tab.sessionId) ? 'completed' : 'idle')
      map.set(tab.id, status)
    }
  }
  return map
})

// ===== 操作函数 =====

function createScratchPadTab(): TabItem {
  return {
    id: SCRATCH_PAD_ID,
    type: 'scratch',
    sessionId: SCRATCH_PAD_ID,
    title: SCRATCH_PAD_TITLE,
  }
}

/** 主区应展示会话内容的标签（不含仅作为落地占位的 Scratch Pad） */
export function isPrimaryContentTab(tab: TabItem): boolean {
  return tab.type === 'chat' || tab.type === 'agent' || tab.type === 'tutorial'
}

/** 没有会话/教程时视为主页空态；用户主动打开的 Scratch Pad 仍显示草稿本 */
export function isHomeLanding(tabs: TabItem[], activeTabId: string | null): boolean {
  if (tabs.some(isPrimaryContentTab)) return false
  return !activeTabId || !tabs.some((tab) => tab.id === activeTabId)
}

function getPersistentTabs(tabs: TabItem[]): TabItem[] {
  return tabs.filter((tab) => tab.id !== SCRATCH_PAD_ID && tab.id !== TUTORIAL_TAB_ID)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 启动恢复时只保留真实会话入口，跳过空白草稿，避免一打开就进欢迎页 */
export function filterRestorableSessionTabs(
  tabs: unknown[],
  validSessionIds: Set<string>,
  draftSessionIds: Set<string> = new Set(),
): TabItem[] {
  return tabs.filter((tab): tab is TabItem => {
    if (!isRecord(tab)) return false
    if (typeof tab.id !== 'string' || typeof tab.sessionId !== 'string' || typeof tab.title !== 'string') {
      return false
    }
    if (tab.type !== 'chat' && tab.type !== 'agent') return false
    if (!validSessionIds.has(tab.sessionId)) return false
    if (draftSessionIds.has(tab.sessionId)) return false
    return true
  })
}

export function getPersistableTabState(
  tabs: TabItem[],
  activeTabId: string | null,
  draftSessionIds?: Set<string>,
): PersistedTabState {
  const persistentTabs = getPersistentTabs(tabs).filter((tab) => !draftSessionIds?.has(tab.sessionId))
  const persistentActiveTabId = activeTabId && persistentTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : persistentTabs.at(-1)?.id ?? null

  return {
    tabs: persistentTabs,
    activeTabId: persistentActiveTabId,
  }
}

/** 打开或聚焦会话入口：始终用目标会话替换当前会话，避免顶部累积多个 Tab。
 *  Scratch Pad 只在用户主动打开时进入标签列表，不再作为默认落地页。 */
export function openTab(
  tabs: TabItem[],
  item: { type: TabType; sessionId: string; title: string },
): { tabs: TabItem[]; activeTabId: string } {
  if (item.type === 'scratch') {
    const scratchTab = tabs.find((t) => t.id === SCRATCH_PAD_ID) ?? createScratchPadTab()
    return {
      tabs: [scratchTab],
      activeTabId: SCRATCH_PAD_ID,
    }
  }

  if (item.type === 'tutorial') {
    const tutorialTab: TabItem = tabs.find((t) => t.id === TUTORIAL_TAB_ID) ?? {
      id: TUTORIAL_TAB_ID,
      type: 'tutorial',
      sessionId: TUTORIAL_TAB_ID,
      title: TUTORIAL_TAB_TITLE,
    }
    return {
      tabs: [tutorialTab],
      activeTabId: TUTORIAL_TAB_ID,
    }
  }

  const sessionTab = tabs.find((t) => t.sessionId === item.sessionId && t.type === item.type) ?? {
    id: item.sessionId,
    type: item.type,
    sessionId: item.sessionId,
    title: item.title,
  }

  return {
    tabs: [sessionTab],
    activeTabId: sessionTab.id,
  }
}

/** 关闭标签页。关闭最后一个会话后回到主页空态，不再回落到 Scratch Pad。 */
export function closeTab(
  tabs: TabItem[],
  activeTabId: string | null,
  tabId: string,
): { tabs: TabItem[]; activeTabId: string | null } {
  const tabIndex = tabs.findIndex((t) => t.id === tabId)
  if (tabIndex === -1) return { tabs, activeTabId }

  const newTabs = tabs.filter((t) => t.id !== tabId)
  const remainingContent = newTabs.filter(isPrimaryContentTab)
  const nextActiveTabId = activeTabId !== tabId
    ? activeTabId
    : remainingContent.length === 0
      ? null
      : remainingContent[Math.min(tabIndex, remainingContent.length - 1)]!.id

  return {
    tabs: remainingContent.length > 0 ? newTabs : [],
    activeTabId: nextActiveTabId,
  }
}

/** 关闭指定会话入口。当前入口不是这些会话时保持原样，例如草稿本不受归档影响。 */
export function closeSessionTabs(
  tabs: TabItem[],
  activeTabId: string | null,
  sessionIds: Iterable<string>,
): { tabs: TabItem[]; activeTabId: string | null } {
  let nextTabs = tabs
  let nextActiveTabId = activeTabId
  const ids = new Set(sessionIds)

  for (const tab of tabs) {
    if (tab.type !== 'agent' && tab.type !== 'chat') continue
    if (!ids.has(tab.sessionId)) continue
    const result = closeTab(nextTabs, nextActiveTabId, tab.id)
    nextTabs = result.tabs
    nextActiveTabId = result.activeTabId
  }

  return { tabs: nextTabs, activeTabId: nextActiveTabId }
}

/** 更新标签标题 */
export function updateTabTitle(
  tabs: TabItem[],
  sessionId: string,
  title: string,
): TabItem[] {
  return tabs.map((t) =>
    t.sessionId === sessionId ? { ...t, title } : t
  )
}
