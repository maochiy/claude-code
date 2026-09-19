/**
 * DiffPanelTabBar — 右侧动态功能区 Tab 栏
 *
 * 只展示当前会话已经打开的功能；加号菜单用于打开尚未显示的功能。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FileDiff, Files, ListTodo, Plus, Terminal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation, type TranslationKey } from '@/lib/i18n'
import { WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  agentDiffUnseenChangesAtom,
  isAgentExecutionNodeTab,
  isAgentTerminalTab,
  isBrowserTaskTab,
  isBrowserInstanceTab,
  currentAgentSessionIdAtom,
  getAgentSidePanelGroup,
} from '@/atoms/agent-atoms'
import type {
  AgentSidePanelStaticTab,
  AgentSidePanelTab,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelAddTab } from '@/lib/agent-side-panel-tabs'

interface DiffPanelTabBarProps {
  activeTab: AgentSidePanelTab
  openTabs: AgentSidePanelTab[]
  availableTabs: AgentSidePanelAddTab[]
  onTabChange: (tab: AgentSidePanelTab) => void
  onTabClose: (tab: AgentSidePanelTab) => void
  onTabAdd: (tab: AgentSidePanelAddTab) => void
  /** 面板级关闭（不关 Tab、不杀终端进程），用于单 Tab 细标题行的 × */
  onClosePanel?: () => void
  onTabReorder: (source: AgentSidePanelTab, target: AgentSidePanelTab) => void
  getTabLabel?: (tab: AgentSidePanelTab) => string | undefined
  isWindows?: boolean
  /** 当前功能专属动作（复制、定位源文件、展开等）。 */
  toolbarActions?: React.ReactNode
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: AgentSidePanelTab
}

const TAB_LABEL_KEYS: Record<AgentSidePanelAddTab, TranslationKey> = {
  browser: 'sidePanel.browser',
  tasks: 'sidePanel.tasks',
  files: 'sidePanel.files',
  changes: 'sidePanel.changes',
  plan: 'sidePanel.plan',
  execution: 'sidePanel.execution',
  chat: 'sidePanel.chat',
  terminal: 'sidePanel.terminal',
}

export function DiffPanelTabBar({
  activeTab,
  openTabs,
  availableTabs,
  onTabChange,
  onTabClose,
  onTabAdd,
  onClosePanel,
  onTabReorder,
  getTabLabel,
  isWindows = false,
  toolbarActions,
}: DiffPanelTabBarProps): React.ReactElement {
  const { t } = useTranslation()
  const activeGroup = getAgentSidePanelGroup(activeTab)
  const panelTabs = openTabs.filter((tab) => getAgentSidePanelGroup(tab) === activeGroup)
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const prevTabStateRef = React.useRef<PreviousTabState>({ sessionId: currentSessionId, activeTab })
  const preventAddMenuFocusRestoreRef = React.useRef(false)
  const [draggingTab, setDraggingTab] = React.useState<AgentSidePanelTab | null>(null)
  const [addMenuOpen, setAddMenuOpen] = React.useState(false)

  React.useEffect(() => {
    if (availableTabs.length === 0) setAddMenuOpen(false)
  }, [availableTabs.length])

  const clearUnseen = React.useCallback((sessionId = currentSessionId) => {
    if (!sessionId) return
    setUnseenMap((previous) => {
      if (previous.get(sessionId) === false) return previous
      const next = new Map(previous)
      next.set(sessionId, false)
      return next
    })
  }, [currentSessionId, setUnseenMap])

  React.useEffect(() => {
    const previous = prevTabStateRef.current
    if (
      previous.sessionId === currentSessionId
      && previous.activeTab === 'changes'
      && activeTab !== 'changes'
    ) {
      clearUnseen(currentSessionId)
    }
    prevTabStateRef.current = { sessionId: currentSessionId, activeTab }
  }, [activeTab, clearUnseen, currentSessionId])

  const handleTabChange = React.useCallback((tab: AgentSidePanelTab) => {
    if (tab === 'changes') clearUnseen()
    onTabChange(tab)
  }, [clearUnseen, onTabChange])
  const resolveTabLabel = React.useCallback((tab: AgentSidePanelTab): string => {
    if (isAgentExecutionNodeTab(tab)) return getTabLabel?.(tab) ?? t('sidePanel.executionNode')
    if (isAgentTerminalTab(tab)) return getTabLabel?.(tab) ?? t('sidePanel.terminal')
    if (isBrowserTaskTab(tab)) return getTabLabel?.(tab) ?? t('sidePanel.browserTask')
    if (isBrowserInstanceTab(tab)) return getTabLabel?.(tab) ?? t('sidePanel.browser')
    return t(TAB_LABEL_KEYS[tab as AgentSidePanelStaticTab])
  }, [getTabLabel, t])

  /** 终端内的加号直接新建终端，不再混入文件和改动。 */
  const addMenuButton = activeGroup === 'terminal' ? (
    <button
      type="button"
      className="titlebar-no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/55 hover:text-foreground"
      aria-label={t('sidePanel.newTerminal')}
      onClick={() => onTabAdd('terminal')}
    >
      <Plus className="size-4" />
    </button>
  ) : (
    <Popover
      open={addMenuOpen}
      onOpenChange={(open) => {
        if (open) preventAddMenuFocusRestoreRef.current = false
        setAddMenuOpen(open)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="titlebar-no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:opacity-35"
          aria-label={t('sidePanel.add')}
          disabled={availableTabs.length === 0}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-40 p-1"
        data-side-panel-add-menu
        onCloseAutoFocus={(event) => {
          if (!preventAddMenuFocusRestoreRef.current) return
          // 只有新建终端时才由 xterm 接管焦点；其它菜单操作保留 Radix 默认行为。
          preventAddMenuFocusRestoreRef.current = false
          event.preventDefault()
        }}
      >
        {availableTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent/70"
            onClick={() => {
              preventAddMenuFocusRestoreRef.current = tab === 'terminal'
              onTabAdd(tab)
              setAddMenuOpen(false)
            }}
          >
            {t(TAB_LABEL_KEYS[tab])}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )

  return (
    <div className="relative flex h-[34px] flex-shrink-0 items-center bg-content-area">
      <div className={cn('absolute inset-0 titlebar-drag-region', isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
      {panelTabs.length <= 1 ? (
        /* 单 Tab 时对齐参考桌面端：细标题行（标题居左，右侧关闭；终端 Tab 额外保留 + 新增） */
        <div className="relative flex h-full min-w-0 flex-1 items-center gap-1 titlebar-no-drag pl-2 pr-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground/80">
            {(() => {
              const onlyTab = activeTab
              const iconClass = 'size-3 shrink-0 text-foreground/55'
              if (isAgentTerminalTab(onlyTab)) return <Terminal className={iconClass} />
              if (onlyTab === 'tasks') return <ListTodo className={iconClass} />
              if (onlyTab === 'files') return <Files className={iconClass} />
              if (onlyTab === 'changes') return <FileDiff className={iconClass} />
              return null
            })()}
            <span className="truncate">{resolveTabLabel(activeTab)}</span>
          </span>
          {isAgentTerminalTab(activeTab) && addMenuButton}
          <div className="ml-auto flex items-center gap-0.5">
            {toolbarActions}
            <button
              type="button"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
              aria-label={onClosePanel ? t('sidePanel.close') : t('sidePanel.closeTab', { name: resolveTabLabel(activeTab) })}
              onClick={() => onClosePanel ? onClosePanel() : onTabClose(activeTab)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : (
      <div className="relative flex h-full min-w-0 flex-1 items-center gap-1 px-1.5 titlebar-no-drag">
        <div className="scrollbar-none flex w-fit min-w-0 flex-initial items-center gap-0.5 overflow-x-auto">
          {panelTabs.map((tab) => {
            const label = resolveTabLabel(tab)
            return (
              <div
                key={tab}
                draggable
                onDragStart={() => setDraggingTab(tab)}
                onDragEnd={() => setDraggingTab(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggingTab && draggingTab !== tab) onTabReorder(draggingTab, tab)
                  setDraggingTab(null)
                }}
                className={cn(
                  'group flex h-7 min-w-[80px] max-w-[168px] flex-none items-center rounded-md text-[13px] transition-colors',
                  activeTab === tab
                    ? 'bg-muted/60 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  draggingTab === tab && 'opacity-55',
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 self-stretch px-2"
                  onClick={() => handleTabChange(tab)}
                >
                  <span className="flex items-center justify-center gap-1 truncate">
                    {isAgentTerminalTab(tab) && <Terminal className="size-3 shrink-0" />}
                    {tab === 'changes' && unseenChanges && activeTab !== 'changes' && (
                      <span className="size-2 shrink-0 rounded-full bg-primary ring-1 ring-background" />
                    )}
                    <span className="truncate">{label}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted/70 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('sidePanel.closeTab', { name: label })}
                  onClick={() => onTabClose(tab)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>

        {addMenuButton}
        <div className="ml-auto flex items-center gap-0.5">
          {toolbarActions}
          {onClosePanel && (
            <button
              type="button"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/55 hover:text-foreground"
              aria-label={t('sidePanel.close')}
              onClick={onClosePanel}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
