/**
 * MainArea — 主内容区域
 *
 * 无会话标签时展示主页空态；打开会话后由会话头 + TabContent 接管。
 * 主区域只保留草稿分屏；文件预览由浮动右侧 Files 面板承载。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  activeTabAtom,
  isHomeLanding,
  scratchPadPanelOpenAtom,
} from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { HomeView } from '@/components/home/HomeView'
import { previewSplitRatioAtom } from '@/atoms/preview-atoms'
import { ScratchPadPane } from '@/components/scratch-pad/ScratchPadView'
import { closeScratchInSplit } from '@/components/scratch-pad/scratch-pad-opener'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { AutomationsListView } from '@/components/automation/AutomationsListView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { TaskboardView } from '@/components/taskboard/TaskboardView'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { interfaceVariantAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'

export function MainArea(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const store = useStore()

  const [splitRatio, setSplitRatio] = useAtom(previewSplitRatioAtom)
  const previewDragging = React.useRef(false)
  const scratchPanelOpen = useAtomValue(scratchPadPanelOpenAtom)
  const showScratchPanel =
    activeTab?.type === 'agent' && scratchPanelOpen && activeView === 'conversations'

  const handlePreviewDragStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    previewDragging.current = true
    const startX = e.clientX
    const startRatio = splitRatio
    const containerEl = (e.currentTarget as HTMLElement).closest('[data-split-container]') as HTMLElement | null
    const containerWidth = containerEl?.clientWidth ?? 1
    let rafId = 0

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = 'none' })

    const onMouseMove = (ev: MouseEvent) => {
      if (!previewDragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newRatio = Math.max(0.3, Math.min(0.8, startRatio + delta / containerWidth))
        setSplitRatio(newRatio)
      })
    }
    const onMouseUp = () => {
      previewDragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitRatio, setSplitRatio])

  const handleCloseScratchPanel = React.useCallback(() => {
    closeScratchInSplit(store)
  }, [store])

  const showHome = isHomeLanding(tabs, activeTabId)

  React.useEffect(() => {
    if (showHome || activeTabId || tabs.length === 0) return
    setActiveTabId(tabs[0]!.id)
  }, [tabs, activeTabId, setActiveTabId, showHome])

  // 草稿工作区继续沿用原分栏比例；文件预览不再改变主区宽度。
  const leftFlexStyle: React.CSSProperties = showScratchPanel
    ? { flex: `0 0 calc(${splitRatio * 100}% - 6px)` }
    : { flex: '1 1 auto' }

  return (
    <>
      <Panel
        variant="grow"
        className={cn('bg-content-area', isClassic && 'rounded-2xl shadow-xl dark:shadow-sm')}
      >
        <div className="flex flex-1 min-h-0 relative overflow-hidden" data-split-container>
          {/* 左侧：会话内容（始终保持在同一 DOM 位置，避免切换时 unmount）
              注：宽度变化不用 transition——文字逐帧 reflow 会导致行末字符抖动，
              视觉上像"内容从右向左推送"。让左侧瞬间变宽，由右侧 absolute 滑出动画
              覆盖期内呈现"被剥离"的视觉效果。 */}
          <div
            className="flex h-full min-w-0 flex-col relative"
            style={leftFlexStyle}
          >
            {activeView === 'automations' ? (
              automationFormOpen ? (
                <AutomationFormView />
              ) : (
                <AutomationsListView />
              )
            ) : activeView === 'agent-skills' ? (
              <AgentSkillsView />
            ) : activeView === 'taskboard' ? (
              <TaskboardView />
            ) : automationFormOpen ? (
              <AutomationFormView />
            ) : showHome ? (
              <HomeView />
            ) : activeTabId ? (
              <div className="flex-1 min-h-0 titlebar-no-drag">
                <TabContent tabId={activeTabId} />
              </div>
            ) : (
              <HomeView />
            )}
          </div>

          {/* 草稿工作区是主内容区唯一保留的分屏。 */}
          {showScratchPanel && (
            <div className="flex min-w-0 flex-1">
              <div
                className="w-[8px] cursor-col-resize bg-border/40 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 self-stretch"
                onMouseDown={handlePreviewDragStart}
              />
              <div className="h-full min-w-[260px] flex-1 overflow-hidden">
                <ScratchPadPane onClose={handleCloseScratchPanel} />
              </div>
            </div>
          )}
        </div>
      </Panel>
    </>
  )
}
