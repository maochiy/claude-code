/**
 * RightSidePanel — 右侧边栏容器
 *
 * 在 Agent 模式下显示文件面板，样式与 LeftSidebar 一致。
 * 从全局 atom 读取当前会话 ID 和路径。
 * 管理「会话文件 / 工作区文件 / 代码改动」Tab 切换。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { appModeAtom } from '@/atoms/app-mode'
import {
  closeAgentSidePanelAtom,
  currentAgentSessionIdAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtom,
  agentSidePanelStackAtom,
  agentSidePanelTabsAtom,
  closeAgentSidePanelPaneAtom,
  closeAgentSidePanelTabAtom,
  openAgentSidePanelTabAtom,
  reorderAgentSidePanelTabsAtom,
  agentSessionsAtom,
  createAgentTerminalTab,
  createBrowserInstanceTab,
  getAgentTerminalSessionId,
  agentBrowserInstanceCounterAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { SidePanel } from '@/components/agent/SidePanel'
import type { AgentSidePanelAddTab } from '@/lib/agent-side-panel-tabs'
import { resolveSidePanelStackLayout } from '@/lib/side-panel-stack-layout'

export function RightSidePanel({ width }: { width?: number }): React.ReactElement | null {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)

  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const sidePanelTabsMap = useAtomValue(agentSidePanelTabsAtom)
  const sidePanelOpen = useAtomValue(agentSidePanelOpenAtom)
  const sidePanelStack = useAtomValue(agentSidePanelStackAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const closeSidePanelTab = useSetAtom(closeAgentSidePanelTabAtom)
  const reorderSidePanelTabs = useSetAtom(reorderAgentSidePanelTabsAtom)
  const closeSidePanel = useSetAtom(closeAgentSidePanelAtom)
  const closeSidePanelPane = useSetAtom(closeAgentSidePanelPaneAtom)

  const openTabs = currentSessionId
    ? (sidePanelTabsMap.get(currentSessionId) ?? [])
    : []
  const storedActiveTab = currentSessionId
    ? diffPanelTabMap.get(currentSessionId)
    : undefined
  const fallbackActiveTab = storedActiveTab && openTabs.includes(storedActiveTab)
    ? storedActiveTab
    : (openTabs[0] ?? 'files')
  const stackLayout = resolveSidePanelStackLayout(
    sidePanelStack,
    fallbackActiveTab,
  )

  const setActiveTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    openSidePanelTab({ sessionId: currentSessionId, tab })
  }, [currentSessionId, openSidePanelTab])

  const sessionPath = currentSessionId
    ? (sessionPathMap.get(currentSessionId) ?? null)
    : null

  // 兜底：面板开着但没有任何 Tab（历史持久化状态）时自动补一个「工作区文件」
  React.useEffect(() => {
    if (!sidePanelOpen || !currentSessionId) return
    if ((sidePanelTabsMap.get(currentSessionId) ?? []).length === 0) {
      openSidePanelTab({ sessionId: currentSessionId, tab: 'files' })
    }
  }, [sidePanelOpen, currentSessionId, sidePanelTabsMap, openSidePanelTab])

  const handleCreateTerminal = React.useCallback(async (): Promise<void> => {
    if (!currentSessionId) return
    if (!sessionPath) {
      toast.error('会话工作目录尚未就绪，请稍后重试')
      return
    }
    const conversationTitle = agentSessions.find((session) => session.id === currentSessionId)?.title
    try {
      const terminal = await window.electronAPI.createIntegratedTerminal({
        conversationId: currentSessionId,
        conversationTitle,
        cwd: sessionPath,
      })
      const tab = createAgentTerminalTab(terminal.id)
      openSidePanelTab({
        sessionId: currentSessionId,
        tab,
        terminalSnapshot: terminal,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开终端')
    }
  }, [agentSessions, currentSessionId, openSidePanelTab, sessionPath])
  const handleCreateTerminalRequest = React.useCallback(() => {
    void handleCreateTerminal()
  }, [handleCreateTerminal])

  const setBrowserInstanceCounter = useSetAtom(agentBrowserInstanceCounterAtom)

  const handleOpenTab = React.useCallback((tab: AgentSidePanelAddTab) => {
    if (!currentSessionId) return
    if (tab === 'terminal') {
      void handleCreateTerminal()
      return
    }
    if (tab === 'browser') {
      // 浏览器可同时打开多个实例：每次点击都创建唯一 browser-instance Tab。
      const nextIndex = (() => {
        let index = 0
        setBrowserInstanceCounter((previous) => {
          const next = new Map(previous)
          index = (next.get(currentSessionId) ?? 0) + 1
          next.set(currentSessionId, index)
          return next
        })
        return index
      })()
      openSidePanelTab({
        sessionId: currentSessionId,
        tab: createBrowserInstanceTab(String(nextIndex)),
      })
      return
    }
    openSidePanelTab({ sessionId: currentSessionId, tab })
  }, [currentSessionId, handleCreateTerminal, openSidePanelTab, setBrowserInstanceCounter])

  const handleCloseTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    const terminalSessionId = getAgentTerminalSessionId(tab)
    if (terminalSessionId) {
      void window.electronAPI.closeIntegratedTerminal(terminalSessionId).catch(() => {
        // Shell 自己 exit 时主进程已经销毁 session，关闭 Tab 仍应继续。
      })
    }
    closeSidePanelTab({ sessionId: currentSessionId, tab })
  }, [closeSidePanelTab, currentSessionId])

  /** 面板级关闭：只收起面板，终端进程与 Tab 保留（重开时原样恢复） */
  const handleClosePanel = React.useCallback((): void => {
    if (currentSessionId && stackLayout.stackedPrimary) {
      closeSidePanelPane({
        sessionId: currentSessionId,
        tab: stackLayout.stackedPrimary,
      })
      return
    }
    closeSidePanel('__current__')
  }, [closeSidePanel, closeSidePanelPane, currentSessionId, stackLayout.stackedPrimary])

  const handleCloseAuxiliaryPane = React.useCallback((): void => {
    if (!currentSessionId || !stackLayout.auxiliaryTab) return
    closeSidePanelPane({
      sessionId: currentSessionId,
      tab: stackLayout.auxiliaryTab,
    })
  }, [closeSidePanelPane, currentSessionId, stackLayout.auxiliaryTab])

  const handleReorderTabs = React.useCallback((
    source: AgentSidePanelTab,
    target: AgentSidePanelTab,
  ) => {
    if (!currentSessionId || source === target) return
    reorderSidePanelTabs({ sessionId: currentSessionId, source, target })
  }, [currentSessionId, reorderSidePanelTabs])

  if (appMode !== 'agent' || !currentSessionId) {
    return null
  }

  return (
    <SidePanel
      sessionId={currentSessionId}
      sessionPath={sessionPath}
      activeTab={stackLayout.activeTab}
      auxiliaryTab={stackLayout.auxiliaryTab}
      onTabChange={setActiveTab}
      openTabs={openTabs}
      onOpenTab={handleOpenTab}
      onCreateTerminal={handleCreateTerminalRequest}
      onCloseTab={handleCloseTab}
      onClosePanel={handleClosePanel}
      onCloseAuxiliaryPane={handleCloseAuxiliaryPane}
      onReorderTabs={handleReorderTabs}
      width={width}
    />
  )
}
