import { selectedPlanDocumentAtomFamily } from '@/atoms/plan-document'
/**
 * SidePanel — Agent 侧面板容器
 *
 * 文件、改动、终端等功能独立展示；终端的进程生命周期由主进程管理。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { X, FolderOpen, ExternalLink, ChevronRight, MoreHorizontal, Pencil, FolderInput, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'
import { FileTypeIcon, computeRevealAncestors, isPathUnderRoot, computeTreeRowLayout, AncestorGuides, STICKY_ROW_BASE_CLASS, canBeSticky } from '@/components/file-browser'
import { DiffPanelTabBar } from '@/components/diff/DiffPanelTabBar'
import { DiffChangesList } from '@/components/diff/DiffChangesList'
import { ChatView } from '@/components/chat/ChatView'
import { RuntimeExecutionPanel } from './RuntimeExecutionPanel'
import { RuntimePlanPanel, RuntimePlanToolbar } from './RuntimePlanPanel'
import { FilePanelDropTarget } from './FilePanelDropTarget'
import { referenceFilePaths } from './file-panel-actions'
import type { FilePanelReferenceResult, FilePanelUploadEntry } from './file-panel-actions'
import {
  agentSidePanelOpenAtom,
  agentSidePanelTabsAtom,
  workspaceFilesVersionAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  agentPendingFilesAtomFamily,
  agentDiffRefreshVersionAtom,
  fileBrowserAutoRevealAtom,
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimePlanLifecycleAtom,
  agentExecutionNodeTabSnapshotsAtom,
  agentTerminalTabSnapshotsAtom,
  agentSidePanelRuntimeHistoryAtom,
  agentSessionsAtom,
  createAgentTerminalTab,
  agentStreamingStatesAtom,
  createAgentExecutionNodeTab,
  getAgentExecutionNodeId,
  getBrowserTaskId,
  getBrowserInstanceId,
  getAgentTerminalSessionId,
  isAgentExecutionNodeTab,
  isBrowserTaskTab,
  isBrowserInstanceTab,
  isAgentTerminalTab,
  openAgentSidePanelTabAtom,
  backgroundTasksAtomFamily,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { BrowserPanel } from './BrowserPanel'
import { useBrowserAgentTasks } from '@/hooks/useBrowserAgentTasks'
import { browserAgentTasksAtom } from '@/atoms/browser-atoms'
import { agentSideChatMapAtom } from '@/atoms/chat-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import { detectIsWindows } from '@/lib/platform'
import { getAvailableAgentSidePanelTabs } from '@/lib/agent-side-panel-tabs'
import { getVisibleRuntimePlanTodos } from '@/lib/runtime-plan-lifecycle'
import {
  buildSessionExecutionNodes,
  isSubagentExecutionNode,
  isSessionExecutionNodeDetailRunning,
} from '@/lib/session-execution-nodes'
import type {
  AgentPendingFile,
  AgentRuntimeExecutionNode,
  FileEntry,
} from '@proma/shared'
import { RuntimeExecutionNodePanel } from './RuntimeExecutionNodePanel'
import { IntegratedTerminalPanel } from './IntegratedTerminalPanel'
import { FilesPanelContent } from './FilesPanelContent'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import type { AgentSidePanelAddTab } from '@/lib/agent-side-panel-tabs'
import { useOpenPreview } from '@/components/diff/preview-opener'

function getPathBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

function getMediaTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
  if (!imageExts.has(ext)) return 'application/octet-stream'
  const mimeExt = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
  return `image/${mimeExt}`
}

interface SidePanelProps {
  sessionId: string
  sessionPath: string | null
  activeTab: AgentSidePanelTab
  /** 计划/后台任务的第二个独立纵向面板。 */
  auxiliaryTab?: 'plan' | 'tasks'
  onTabChange: (tab: AgentSidePanelTab) => void
  openTabs: AgentSidePanelTab[]
  onOpenTab: (tab: AgentSidePanelAddTab) => void
  onCreateTerminal: () => void
  onCloseTab: (tab: AgentSidePanelTab) => void
  onReorderTabs: (source: AgentSidePanelTab, target: AgentSidePanelTab) => void
  /** 面板级关闭（不关 Tab、不杀终端进程） */
  onClosePanel?: () => void
  /** 只关闭第二个独立面板，不影响主面板及其持久内容。 */
  onCloseAuxiliaryPane?: () => void
  width?: number
}

export function SidePanel({
  sessionId,
  sessionPath,
  activeTab,
  auxiliaryTab,
  onTabChange,
  openTabs,
  onOpenTab,
  onCreateTerminal,
  onCloseTab,
  onClosePanel,
  onCloseAuxiliaryPane,
  onReorderTabs,
  width = 280,
}: SidePanelProps): React.ReactElement {
  const { t } = useTranslation()
  // 当前会话的面板可见性；会话切换时默认收起。
  const isOpen = useAtomValue(agentSidePanelOpenAtom)
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const browserAgentTasks = useBrowserAgentTasks(sessionId)
  const allBrowserAgentTasks = useAtomValue(browserAgentTasksAtom)
  const backgroundTasks = useAtomValue(backgroundTasksAtomFamily(sessionId))
  const openPreview = useOpenPreview()
  const [expandedTab, setExpandedTab] = React.useState<'plan' | 'tasks' | null>(null)

  React.useEffect(() => {
    if (expandedTab && expandedTab !== activeTab && expandedTab !== auxiliaryTab) {
      setExpandedTab(null)
    }
  }, [activeTab, auxiliaryTab, expandedTab])

  // 用 ref 存 basePaths 相关值，避免声明顺序问题
  const basePathsRef = React.useRef<string[]>([])

  // 动画标志：isOpen 变化时启用过渡动画，切换会话时即时显示
  const prevIsOpenRef = React.useRef(isOpen)
  const prevSessionIdRef = React.useRef(sessionId)
  const shouldAnimate = prevSessionIdRef.current === sessionId && prevIsOpenRef.current !== isOpen
  React.useEffect(() => {
    prevIsOpenRef.current = isOpen
    prevSessionIdRef.current = sessionId
  })

  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const setFilesVersion = useSetAtom(workspaceFilesVersionAtom)
  const diffRefreshVersionMap = useAtomValue(agentDiffRefreshVersionAtom)
  const diffRefreshVersion = diffRefreshVersionMap.get(sessionId) ?? 0

  // 派生当前工作区 slug（用于会话与工作区文件写入）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug = workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null

  // 附加目录列表（会话级）
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? []
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const attachedFiles = attachedFilesMap.get(sessionId) ?? []

  // 附加目录列表（工作区级）
  const wsAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const setWsAttachedDirsMap = useSetAtom(workspaceAttachedDirectoriesMapAtom)
  const wsAttachedDirs = currentWorkspaceId ? (wsAttachedDirsMap.get(currentWorkspaceId) ?? []) : []
  const wsAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const setWsAttachedFilesMap = useSetAtom(workspaceAttachedFilesMapAtom)
  const wsAttachedFiles = currentWorkspaceId ? (wsAttachedFilesMap.get(currentWorkspaceId) ?? []) : []

  const extraPathsMemo = React.useMemo(
    () => [...attachedDirs, ...wsAttachedDirs],
    [attachedDirs, wsAttachedDirs]
  )

  const fileAccessPathsMemo = React.useMemo(
    () => [...extraPathsMemo, ...attachedFiles, ...wsAttachedFiles],
    [extraPathsMemo, attachedFiles, wsAttachedFiles]
  )

  // 加载工作区级附加目录
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceDirectories(workspaceSlug)
      .then((dirs) => {
        setWsAttachedDirsMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, dirs)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  // 加载工作区级附加文件
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceAttachedFiles(workspaceSlug)
      .then((files) => {
        setWsAttachedFilesMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, files)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // === 会话级：附加/移除目录 ===

  const attachSessionDir = React.useCallback(async (dirPath: string) => {
    const updated = await window.electronAPI.attachDirectory({ sessionId, directoryPath: dirPath })
    setAttachedDirsMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedDirsMap])

  const attachSessionFile = React.useCallback(async (filePath: string) => {
    const updated = await window.electronAPI.attachFile({ sessionId, filePath })
    setAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedFilesMap])

  const handleSessionFilesAttached = React.useCallback(
    async (filePaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(filePaths, attachSessionFile)
    ),
    [attachSessionFile],
  )

  // === 工作区级：附加/移除目录 ===

  const handleSessionDirectoriesDropped = React.useCallback(
    async (directoryPaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(directoryPaths, attachSessionDir)
    ),
    [attachSessionDir],
  )

  // 文件上传完成后递增版本号，触发 FileBrowser 刷新
  const handleFilesUploaded = React.useCallback(() => {
    setFilesVersion((prev) => prev + 1)
  }, [setFilesVersion])

  const handleSaveSessionFiles = React.useCallback(async (files: FilePanelUploadEntry[]): Promise<void> => {
    await window.electronAPI.saveFilesToAgentSession({
      workspaceSlug: workspaceSlug ?? '',
      sessionId,
      files,
    })
    handleFilesUploaded()
  }, [handleFilesUploaded, sessionId, workspaceSlug])

  // 添加文件到聊天
  const pendingFiles = useAtomValue(agentPendingFilesAtomFamily(sessionId))
  const setPendingFiles = useSetAtom(agentPendingFilesAtomFamily(sessionId))
  // 面包屑：显示根路径最后两段
  const breadcrumb = React.useMemo(() => {
    if (!sessionPath) return ''
    const parts = sessionPath.split('/').filter(Boolean)
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : sessionPath
  }, [sessionPath])

  // 工作区文件目录路径
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!workspaceSlug) {
      setWorkspaceFilesPath(null)
      return
    }
    window.electronAPI.getWorkspaceFilesPath(workspaceSlug).then(setWorkspaceFilesPath).catch(() => setWorkspaceFilesPath(null))
  }, [workspaceSlug])

  const worktreeRepoPathsMemo = React.useMemo(
    () => [sessionPath, workspaceFilesPath, ...extraPathsMemo].filter(Boolean) as string[],
    [sessionPath, workspaceFilesPath, extraPathsMemo]
  )

  // RightSidePanel 完全由用户控制：Agent 文件变更不创建或切换 Tab，
  // 也不展开目录、滚动或定位；搜索结果点击仍可发送主动定位信号。

  // 同步 basePaths ref（供 handleFilePreview 使用，避免 hooks 声明顺序问题）
  basePathsRef.current = [sessionPath, workspaceFilesPath, ...fileAccessPathsMemo].filter(Boolean) as string[]
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const sideChatMap = useAtomValue(agentSideChatMapAtom)
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const sideChatConversationId = sideChatMap.get(sessionId) ?? null
  const executionGraph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const runtimePlanLifecycle = useAtomValue(agentRuntimePlanLifecycleAtom).get(sessionId)
  const runtimeHistory = useAtomValue(agentSidePanelRuntimeHistoryAtom).get(sessionId)
  const executionNodeTabSnapshots = useAtomValue(agentExecutionNodeTabSnapshotsAtom)
    .get(sessionId)
  const terminalTabSnapshots = useAtomValue(agentTerminalTabSnapshotsAtom).get(sessionId)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentStreamingStates = useAtomValue(agentStreamingStatesAtom)
  const effectiveExecutionGraph = React.useMemo(() => {
    const nodes = new Map<string, AgentRuntimeExecutionNode>(
      (runtimeHistory?.nodes ?? []).map((node) => [node.id, node]),
    )
    for (const node of executionGraph?.nodes ?? []) nodes.set(node.id, node)
    const fallbackTodos = executionGraph?.todos.length
      ? executionGraph.todos
      : (runtimeHistory?.todos ?? [])
    return {
      runtimeSessionId: executionGraph?.runtimeSessionId,
      nodes: Array.from(nodes.values()),
      todos: getVisibleRuntimePlanTodos(
        runtimePlanLifecycle,
        fallbackTodos,
      ),
      updatedAt: Math.max(
        executionGraph?.updatedAt ?? 0,
        runtimeHistory?.updatedAt ?? 0,
      ),
    }
  }, [executionGraph, runtimeHistory, runtimePlanLifecycle])
  const executionNodes = React.useMemo(
    () => buildSessionExecutionNodes({
      sessionId,
      runtimeGraph: effectiveExecutionGraph,
      sessions: agentSessions,
      liveRuntimeNodeIds: new Set(
        (executionGraph?.nodes ?? []).map((node) => node.id),
      ),
    }).filter(isSubagentExecutionNode),
    [agentSessions, effectiveExecutionGraph, executionGraph?.nodes, sessionId],
  )
  const hasExecutionGraph = executionNodes.length > 0
  const planDocument = useAtomValue(selectedPlanDocumentAtomFamily(sessionId))
  const hasPlan = !!planDocument || effectiveExecutionGraph.todos.length > 0
  const availableTabs = React.useMemo(() => {
    return getAvailableAgentSidePanelTabs({
      openTabs,
      hasExecutionGraph,
      hasPlan,
      hasSideChat: Boolean(sideChatConversationId),
      hasBackgroundTasks: backgroundTasks.length > 0,
    })
  }, [backgroundTasks.length, hasExecutionGraph, hasPlan, openTabs, sideChatConversationId])
  const activeExecutionNodeId = getAgentExecutionNodeId(activeTab)
  const activeTerminalSessionId = getAgentTerminalSessionId(activeTab)
  const activeTerminalSnapshot = isAgentTerminalTab(activeTab)
    ? terminalTabSnapshots?.get(activeTab)
    : undefined
  // 所有会话已打开的浏览器类 Tab（静态 browser + 实例 + 任务），用于多实例常驻渲染。
  // 注意：这里读全局 atom（而非仅当前会话的 openTabs），并固定 key = sessionId:tab，
  // 让每个会话的 webview 各自常驻、复用其专属 partition，切换会话只改显隐、不重载。
  const allSidePanelTabs = useAtomValue(agentSidePanelTabsAtom)
  const browserTabs = React.useMemo(
    () => Array.from(allSidePanelTabs.entries()).flatMap(([sessId, tabs]) =>
      tabs
        .filter((tab) =>
          tab === 'browser' || isBrowserInstanceTab(tab) || isBrowserTaskTab(tab),
        )
        .map((tab) => ({ sessionId: sessId, tab })),
    ),
    [allSidePanelTabs],
  )
  // 当前会话的激活 Tab 是否为浏览器类（决定常驻浏览器层是否可见/参与交互）。
  // 注：层内 webview 始终常驻挂载（含其他会话），仅在不显示浏览器时整层隐藏。
  const isActiveBrowserTab = (
    browserTabs.some((item) => item.sessionId === sessionId) && (
      activeTab === 'browser'
      || isBrowserInstanceTab(activeTab)
      || isBrowserTaskTab(activeTab)
    )
  )
  const activeExecutionNodeSnapshot = activeExecutionNodeId && isAgentExecutionNodeTab(activeTab)
    ? executionNodeTabSnapshots?.get(activeTab)
    : undefined
  // 优先使用实时节点，执行图暂时移除节点后才回退到打开 Tab 时保存的快照。
  const activeExecutionNode = (
    activeExecutionNodeId
      ? executionNodes.find((node) => node.id === activeExecutionNodeId)
      : undefined
  ) ?? activeExecutionNodeSnapshot?.node
  const activeExecutionNodeRunning = activeExecutionNode
    ? isSessionExecutionNodeDetailRunning(
        activeExecutionNode,
        agentStreamingStates.get(sessionId)?.running === true,
        activeExecutionNode.transcriptSessionId
          ? agentStreamingStates.get(activeExecutionNode.transcriptSessionId)?.running
          : undefined,
      )
    : false
  const getTabLabel = React.useCallback((tab: AgentSidePanelTab): string | undefined => {
    if (isAgentTerminalTab(tab)) {
      // 多个终端追加序号，切换语言时只更新标签。
      const terminalTabs = openTabs.filter(isAgentTerminalTab)
      const terminalIndex = terminalTabs.indexOf(tab)
      return terminalTabs.length > 1 && terminalIndex >= 0
        ? `${t('sidePanel.terminal')} ${terminalIndex + 1}`
        : t('sidePanel.terminal')
    }
    const browserTaskId = getBrowserTaskId(tab)
    if (browserTaskId && isBrowserTaskTab(tab)) {
      const browserTask = browserAgentTasks.find((item) => item.taskId === browserTaskId)
      return browserTask?.title || t('sidePanel.browserTask')
    }
    const browserInstanceId = getBrowserInstanceId(tab)
    if (browserInstanceId && isBrowserInstanceTab(tab)) {
      return `${t('sidePanel.browser')} ${browserInstanceId}`
    }
    const nodeId = getAgentExecutionNodeId(tab)
    if (!nodeId || !isAgentExecutionNodeTab(tab)) return undefined
    const node = executionNodeTabSnapshots?.get(tab)?.node
      ?? executionNodes.find((item) => item.id === nodeId)
    return node?.name || node?.description || t('sidePanel.executionNode')
  }, [browserAgentTasks, executionNodeTabSnapshots, executionNodes, openTabs, t])

  const handleCloseChatTab = React.useCallback(() => {
    setSideChatMap((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    onCloseTab('chat')
  }, [onCloseTab, sessionId, setSideChatMap])
  const handleActiveTerminalExit = React.useCallback(() => {
    if (!activeTerminalSessionId) return
    onCloseTab(createAgentTerminalTab(activeTerminalSessionId))
  }, [activeTerminalSessionId, onCloseTab])
  const handleOpenPlanSource = React.useCallback((sourcePath: string): void => {
    openPreview(sessionId, {
      filePath: sourcePath,
      previewOnly: true,
      readOnly: true,
      basePaths: basePathsRef.current,
    })
  }, [openPreview, sessionId])
  const toggleExpandedTab = React.useCallback((tab: 'plan' | 'tasks'): void => {
    setExpandedTab(previous => previous === tab ? null : tab)
  }, [])

  React.useEffect(() => {
    if (sideChatConversationId || !openTabs.includes('chat')) return
    onCloseTab('chat')
  }, [onCloseTab, openTabs, sideChatConversationId])

  const paneSurfaceClass = cn(
    'relative min-h-0 basis-0 overflow-hidden bg-content-area',
    !isClassic && 'agent-panel-surface',
    isClassic && 'rounded-2xl shadow-xl dark:shadow-md',
  )

  return (
    <div
      className={cn(
        'relative z-0 h-full flex-shrink-0 overflow-hidden',
        shouldAnimate && 'transition-[width] duration-300 ease-in-out',
        isOpen ? '' : '!w-0',
      )}
      style={isOpen ? { width } : undefined}
      aria-hidden={!isOpen}
    >
      <div
        className={cn(
          'relative flex h-full w-full flex-col gap-2 titlebar-no-drag',
          isWindows ? 'pt-[34px]' : 'pt-0',
          shouldAnimate && 'transition-opacity duration-300',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        // 收起只裁切外壳，内容宽度保持不变，避免 xterm 在动画中被压成几列而破坏回滚区。
        style={{ width }}
      >
        {/* 主面板保持唯一实例，浏览器 webview 与终端组件不会因堆叠而重复挂载。 */}
        <section
          className={cn(
            paneSurfaceClass,
            'flex flex-1 flex-col',
            expandedTab != null && expandedTab !== activeTab && 'hidden',
          )}
          data-side-panel-pane={activeTab}
          data-side-panel-size={expandedTab === activeTab ? 'expanded' : 'equal'}
        >
          <DiffPanelTabBar
            activeTab={activeTab}
            openTabs={openTabs}
            availableTabs={availableTabs}
            onTabChange={onTabChange}
            onTabClose={(tab) => {
              if (tab === 'chat') handleCloseChatTab()
              else onCloseTab(tab)
            }}
            onClosePanel={onClosePanel}
            onTabAdd={(tab) => {
              if (tab === 'terminal') onCreateTerminal()
              else onOpenTab(tab)
            }}
            onTabReorder={onReorderTabs}
            getTabLabel={getTabLabel}
            isWindows={isWindows}
            toolbarActions={(activeTab === 'plan' || activeTab === 'tasks') ? (
              <RuntimePlanToolbar
                document={activeTab === 'plan' ? planDocument : undefined}
                expanded={expandedTab === activeTab}
                onToggleExpanded={auxiliaryTab && (activeTab === 'plan' || activeTab === 'tasks')
                  ? () => toggleExpandedTab(activeTab)
                  : undefined}
                onOpenSource={handleOpenPlanSource}
              />
            ) : undefined}
          />

          <div className="relative flex min-h-0 flex-1 flex-col">
              {activeTerminalSessionId ? (
                isOpen &&
                <IntegratedTerminalPanel
                  sessionId={sessionId}
                  terminalSessionId={activeTerminalSessionId}
                  terminalCwd={activeTerminalSnapshot?.cwd ?? null}
                  currentSessionPath={sessionPath}
                  onCreateSibling={onCreateTerminal}
                  onExit={handleActiveTerminalExit}
                />
              ) : activeExecutionNodeId ? (
                activeExecutionNode ? (
                  <RuntimeExecutionNodePanel
                    cacheKey={`${sessionId}:${activeTab}`}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    node={activeExecutionNode}
                    running={activeExecutionNodeRunning}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
                    该执行节点已不存在或尚未同步。
                  </div>
                )
              ) : activeTab === 'chat' ? (
                sideChatConversationId ? (
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ChatView conversationId={sideChatConversationId} />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">暂无问答会话</div>
                )
              ) : activeTab === 'execution' ? (
                <RuntimeExecutionPanel
                  sessionId={sessionId}
                  onOpenNode={(node, runtimeSessionId) => {
                    const tab = createAgentExecutionNodeTab(node.id, runtimeSessionId)
                    openSidePanelTab({
                      sessionId,
                      tab,
                      executionNodeSnapshot: {
                        node,
                        runtimeSessionId,
                      },
                    })
                  }}
                />
              ) : activeTab === 'plan' ? (
                <RuntimePlanPanel sessionId={sessionId} />
              ) : activeTab === 'tasks' ? (
                <BackgroundTasksPanel tasks={backgroundTasks} />
              ) : isActiveBrowserTab ? (
                <div className="flex-1 min-h-0" data-persistent-browser-underlay />
              ) : activeTab === 'changes' ? (
                sessionPath ? (
                  <DiffChangesList
                    key={sessionId}
                    dirPath={sessionPath}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    workspaceFilesPath={workspaceFilesPath || undefined}
                    extraPaths={fileAccessPathsMemo}
                    refreshVersion={diffRefreshVersion}
                    workspaceSlug={workspaceSlug || undefined}
                    worktreeRepoPaths={worktreeRepoPathsMemo}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
                )
              ) : activeTab === 'files' ? (
                sessionPath ? (
                  <FilesPanelContent
                    key={sessionId}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    onSaveFiles={handleSaveSessionFiles}
                    onReferenceFiles={handleSessionFilesAttached}
                    onAddDirectories={handleSessionDirectoriesDropped}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
                )
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">未知面板</div>
              )}
          </div>

          {/* 常驻浏览器层：始终挂载，但不参与 flex 高度分配；固定定位在 34px Tab 栏下方。
              非浏览器 Tab 必须用 display:none。visibility/opacity/pointer-events 挡不住
              Electron webview 的原生合成层，会把文件列表的点击和滚动全部吞掉。 */}
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 z-[1]',
              isActiveBrowserTab ? 'block' : 'hidden',
            )}
            // Windows 标题栏预留已经由外层纵向容器承担，这里只避开当前面板自己的 Tab 栏。
            style={{ top: 34 }}
          >
            {/* 每个会话的每个浏览器 Tab（静态/实例/任务）独立挂载一个 webview，
                始终不卸载；仅当前会话的激活浏览器 Tab 显示，其余 display:none。
                切换会话 / 切换 Tab / 面板开合都不会重建 webview，已打开的页面不会重新加载。
                每个会话使用独立 partition（Cookie/localStorage/缓存隔离）。 */}
            <div
              className="absolute inset-0 z-[1] flex min-h-0 flex-col bg-background"
              data-persistent-browser-layer
            >
              {browserTabs.map(({ sessionId: tabSessionId, tab }) => {
                // 仅当前会话的激活浏览器 Tab 可见，其他会话/其他 Tab 常驻但隐藏
                const active = tabSessionId === sessionId && tab === activeTab
                const taskId = isBrowserTaskTab(tab)
                  ? (getBrowserTaskId(tab) ?? undefined)
                  : undefined
                const browserTask = taskId ? allBrowserAgentTasks.get(taskId) : undefined
                return (
                  <div
                    // key 固定为 sessionId:tab：常驻不卸载，切换会话只改显隐
                    key={`${tabSessionId}:${tab}`}
                    className={cn(
                      'absolute inset-0 flex min-h-0 flex-col bg-background',
                      active ? 'block' : 'hidden',
                    )}
                    data-persistent-browser-instance={`${tabSessionId}:${tab}`}
                  >
                    <BrowserPanel
                      key={`${tabSessionId}:${tab}`}
                      sessionId={tabSessionId}
                      taskId={taskId}
                      initialUrl={browserTask?.url}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {auxiliaryTab && (
          <section
            className={cn(
              paneSurfaceClass,
              'flex flex-1 flex-col',
              expandedTab != null && expandedTab !== auxiliaryTab && 'hidden',
            )}
            data-side-panel-pane={auxiliaryTab}
            data-side-panel-size={expandedTab === auxiliaryTab ? 'expanded' : 'equal'}
            data-side-panel-auxiliary
          >
            <header className="relative flex h-[34px] shrink-0 items-center bg-content-area px-2">
              <div className="absolute inset-0 titlebar-drag-region" />
              <span className="relative min-w-0 flex-1 truncate text-[13px] text-foreground/80">
                {t(auxiliaryTab === 'plan' ? 'sidePanel.plan' : 'sidePanel.tasks')}
              </span>
              <RuntimePlanToolbar
                document={auxiliaryTab === 'plan' ? planDocument : undefined}
                expanded={expandedTab === auxiliaryTab}
                onToggleExpanded={() => toggleExpandedTab(auxiliaryTab)}
                onOpenSource={handleOpenPlanSource}
              />
              <button
                type="button"
                className="titlebar-no-drag relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
                aria-label={t('sidePanel.close')}
                onClick={onCloseAuxiliaryPane}
              >
                <X className="size-3.5" />
              </button>
            </header>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {auxiliaryTab === 'plan' ? (
                <RuntimePlanPanel sessionId={sessionId} />
              ) : (
                <BackgroundTasksPanel tasks={backgroundTasks} />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
