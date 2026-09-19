/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题（可点击编辑）与工作区名称（参考截图 7：标题 + 项目徽章 + 右侧工具入口）。
 * 高度对齐原 TabBar 标题栏行（macOS 52px），以便承接全局 drag 条下的点击热区。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, X, Laptop, Terminal, EllipsisVertical, FolderOpen, ExternalLink, Pencil, Trash2, ListTodo, Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  agentSessionsAtom,
  agentSessionPathMapAtom,
  agentSidePanelTabsAtom,
  agentWorkspacesAtom,
  agentSidePanelOpenAtom,
  openAgentSidePanelAtom,
  closeAgentSidePanelAtom,
  openAgentSidePanelTabAtom,
  backgroundTasksAtomFamily,
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimePlanLifecycleAtom,
  agentSidePanelRuntimeHistoryAtom,
} from '@/atoms/agent-atoms'
import { sidebarCollapsedAtom, tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { useCloseTab } from '@/hooks/useCloseTab'
import { registerShortcut } from '@/lib/shortcut-registry'
import { sidebarTopChromeReserve } from '@/lib/sidebar-layout'
import { detectIsMac, detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT, WINDOW_CONTROLS_PADDING_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'
import { shouldShowBackgroundTasksEntry, shouldShowPlanEntry } from './session-menu-visibility'
import { selectedPlanDocumentAtomFamily } from '@/atoms/plan-document'
import { getVisibleRuntimePlanTodos } from '@/lib/runtime-plan-lifecycle'

interface AgentHeaderProps {
  sessionId: string
  onOpenTerminal: () => void
}

export function AgentHeader({
  sessionId,
  onOpenTerminal,
}: AgentHeaderProps): React.ReactElement | null {
  const { t } = useTranslation()
  const isMac = detectIsMac()
  const isWindows = detectIsWindows()
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const sidePanelTabsMap = useAtomValue(agentSidePanelTabsAtom)
  const backgroundTasks = useAtomValue(backgroundTasksAtomFamily(sessionId))
  const showBackgroundTasks = shouldShowBackgroundTasksEntry(backgroundTasks.length)
  const planDocument = useAtomValue(selectedPlanDocumentAtomFamily(sessionId))
  const runtimeGraph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const runtimePlanLifecycle = useAtomValue(agentRuntimePlanLifecycleAtom).get(sessionId)
  const runtimeHistory = useAtomValue(agentSidePanelRuntimeHistoryAtom).get(sessionId)
  const fallbackTodos = runtimeGraph?.todos.length
    ? runtimeGraph.todos
    : (runtimeHistory?.todos ?? [])
  const visiblePlanTodos = getVisibleRuntimePlanTodos(runtimePlanLifecycle, fallbackTodos)
  const showPlan = shouldShowPlanEntry({
    hasPlanDocument: Boolean(planDocument),
    visibleTodoCount: visiblePlanTodos.length,
  })
  const session = sessions.find((s) => s.id === sessionId) ?? null
  // 终端打开中 → 头部终端图标显示激活态（参考：有运行内容时图标高亮）
  const hasOpenTerminal = (sidePanelTabsMap.get(sessionId) ?? []).some((tab) => tab.startsWith('terminal:'))
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const { executeClose } = useCloseTab()

  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false)

  // 顶栏图标与快捷键共享同一面板状态。
  const isPanelOpen = useAtomValue(agentSidePanelOpenAtom)
  const openSidePanel = useSetAtom(openAgentSidePanelAtom)
  const closeSidePanel = useSetAtom(closeAgentSidePanelAtom)
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)

  const workspaceName = session?.workspaceId
    ? workspaces.find((workspace) => workspace.id === session.workspaceId)?.name ?? null
    : null

  const togglePanel = React.useCallback(() => {
    if (isPanelOpen) closeSidePanel(sessionId)
    else openSidePanel(sessionId)
  }, [closeSidePanel, isPanelOpen, openSidePanel, sessionId])

  React.useEffect(() => {
    return registerShortcut('toggle-right-panel', togglePanel)
  }, [togglePanel])

  if (!session) return null

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, trimmed)
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
    }
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  /** 用指定应用打开会话目录（Open in 子菜单） */
  const handleOpenIn = (appName: string): void => {
    const workspace = session.workspaceId
      ? workspaces.find((item) => item.id === session.workspaceId)
      : undefined
    const openTarget = (path: string | null): void => {
      if (!path) return
      window.electronAPI.systemOpenFile(path, appName, { sessionId: session.id })
        .catch((error: unknown) => console.error('[AgentHeader] Open in 失败:', error))
    }
    const sessionPath = sessionPathMap.get(session.id)
    if (sessionPath) {
      openTarget(sessionPath)
    } else if (workspace) {
      void window.electronAPI.getWorkspaceFilesPath(workspace.slug)
        .then((path) => openTarget(path))
        .catch((error: unknown) => console.error('[AgentHeader] 获取工作区目录失败:', error))
    }
  }

  /** 确认删除会话：关闭标签页并从列表移除 */
  const handleConfirmDelete = async (): Promise<void> => {
    setDeleteConfirmOpen(false)
    try {
      const result = await window.electronAPI.deleteAgentSession(session.id)
      setAgentSessions((prev) => prev.filter((item) => item.id !== session.id))
      executeClose(session.id)
      if (result.retainedWorktree) {
        toast.warning(t(result.retainedWorktree.reason === 'dirty'
          ? 'agent.worktreeRetainedDirty'
          : 'agent.worktreeRetainedCleanupFailed'), {
          description: result.retainedWorktree.path,
          duration: 10_000,
        })
      } else {
        toast.success(t('agent.deleted'))
      }
    } catch (error) {
      console.error('[AgentHeader] 删除会话失败:', error)
      toast.error(t('agent.deleteFailed'), {
        description: error instanceof Error ? error.message : t('common.unknownError'),
      })
    }
  }

  return (
    <div
      className={cn(
        'relative z-[51] flex shrink-0 items-center gap-2 pr-3',
        isMac ? 'h-[52px]' : 'h-11',
      )}
      style={{
        paddingLeft: sidebarCollapsed ? sidebarTopChromeReserve(isMac) : 20,
      }}
    >
      {/* 原生拖动区按主布局裁切，不能覆盖收起侧栏后的固定展开按钮。 */}
      <div
        className={cn('absolute inset-y-0 right-0 titlebar-drag-region pointer-events-none', isWindows && WINDOW_CONTROLS_INSET_RIGHT)}
        style={{ left: 'var(--main-titlebar-drag-left, 0px)' }}
      />
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="min-w-0 flex-1 border-b border-primary/50 bg-transparent px-0 py-0.5 text-sm font-medium outline-none"
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Laptop className="mr-0.5 size-[15px] shrink-0 text-foreground/75" />
          <button
            type="button"
            onClick={startEdit}
            className="titlebar-no-drag truncate rounded px-0.5 text-[13px] font-medium text-foreground/90 hover:bg-foreground/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={t('agent.renameAria', { title: session.title })}
          >
            {session.title}
          </button>
          {workspaceName && (
            <span className="titlebar-no-drag inline-flex max-w-[160px] shrink-0 items-center rounded-[5px] bg-foreground/[0.09] px-1.5 py-0.5 text-[12px] text-foreground/75">
              <span className="truncate">{workspaceName}</span>
            </span>
          )}
        </div>
      )}
      <div className={cn('ml-auto flex items-center gap-0.5 titlebar-no-drag', isWindows && WINDOW_CONTROLS_PADDING_RIGHT)}>
        <button
          type="button"
          aria-label={t('agent.openTerminal')}
          title={t('agent.openTerminal')}
          onClick={onOpenTerminal}
          className={cn(
            'flex size-7 items-center justify-center rounded-md transition-colors',
            // 有终端在跑：图标转为前景色 + 浅底，对齐参考「打开态」
            hasOpenTerminal
              ? 'bg-foreground/[0.07] text-foreground'
              : 'text-foreground/45 hover:bg-foreground/[0.055] hover:text-foreground/80',
          )}
        >
          <Terminal className="size-[15px]" />
        </button>
        <DropdownMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('agent.moreActions')}
              title={t('common.more')}
              className="flex size-7 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/80"
            >
              <EllipsisVertical className="size-[15px]" />
            </button>
          </DropdownMenuTrigger>
          {/* 对齐参考截图：Files / Open in / Rename R / Fork F / Keep awake / Archive A / Delete D */}
          <DropdownMenuContent
            align="end"
            className="w-52"
            onCloseAutoFocus={(event) => {
              // 阻止关闭后焦点回到触发器：Rename 需要把焦点留在标题输入框
              event.preventDefault()
            }}
            onKeyDown={(event) => {
              // 菜单打开时单字母快捷键（参考桌面端 R/F/A/D）
              const key = event.key.toLowerCase()
              const runAction = (action: () => void): void => {
                event.preventDefault()
                setMoreMenuOpen(false)
                action()
              }
              if (key === 'r') runAction(startEdit)
              else if (key === 'd') runAction(() => setDeleteConfirmOpen(true))
            }}
          >
            <DropdownMenuItem onSelect={() => openSidePanelTab({ sessionId, tab: 'files' })}>
              <FolderOpen className="size-3.5" />
              {t('agent.files')}
            </DropdownMenuItem>
            {showPlan && (
              <DropdownMenuItem onSelect={() => openSidePanelTab({ sessionId, tab: 'plan' })}>
                <Lightbulb className="size-3.5" />
                {t('sidePanel.plan')}
              </DropdownMenuItem>
            )}
            {showBackgroundTasks && (
              <DropdownMenuItem onSelect={() => openSidePanelTab({ sessionId, tab: 'tasks' })}>
                <ListTodo className="size-3.5" />
                {t('sidePanel.tasks')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ExternalLink className="size-3.5" />
                {t('agent.openIn')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {/* 参考桌面端：Open in 子菜单列出可用编辑器/访达；序号 1-3 为参考样式 */}
                <DropdownMenuItem onSelect={() => handleOpenIn('Cursor')}>
                  Cursor
                  <DropdownMenuShortcut>1</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleOpenIn('Visual Studio Code')}>
                  VS Code
                  <DropdownMenuShortcut>2</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleOpenIn('Finder')}>
                  Finder
                  <DropdownMenuShortcut>3</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={startEdit}>
              <Pencil className="size-3.5" />
              {t('agent.rename')}
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDeleteConfirmOpen(true)}
              className="text-[#CD2054] focus:bg-[#CD2054]/10 focus:text-[#CD2054] data-[highlighted]:bg-[#CD2054]/10 data-[highlighted]:text-[#CD2054]"
            >
              <Trash2 className="size-3.5" />
              {t('common.delete')}
              <DropdownMenuShortcut>D</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 删除确认（对齐侧边栏删除交互） */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('agent.deleteTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('agent.deleteDescription', { title: session.title })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void handleConfirmDelete()}
                className="bg-[#CD2054] text-white hover:bg-[#B31B48]"
              >
                {t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
