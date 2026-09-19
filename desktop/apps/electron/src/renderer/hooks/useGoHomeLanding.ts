/**
 * useGoHomeLanding — 关闭当前会话入口并回到主页空态
 *
 * 「新建会话」不再先创建空白草稿 Tab。主页 HomeView 才是落地页，
 * 真正的会话只在 HomeComposer 提交时创建。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeViewAtom } from '@/atoms/active-view'
import { sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { activeTabIdAtom, isHomeLanding, tabsAtom } from '@/atoms/tab-atoms'
import { useCloseTab } from '@/hooks/useCloseTab'
import { useProjectActions } from '@/hooks/useProjectActions'

interface GoHomeLandingOptions {
  /** 回到主页前切换到指定项目（侧栏项目行 + 号） */
  workspaceId?: string
}

export function useGoHomeLanding(): (options?: GoHomeLandingOptions) => void {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setViewMode = useSetAtom(sidebarViewModeAtom)
  const { executeClose } = useCloseTab()
  const { selectProject } = useProjectActions()

  return React.useCallback((options?: GoHomeLandingOptions): void => {
    setViewMode('active')
    setActiveView('conversations')
    if (options?.workspaceId) {
      selectProject(options.workspaceId)
    }
    if (isHomeLanding(tabs, activeTabId)) return
    if (activeTabId) executeClose(activeTabId)
  }, [activeTabId, executeClose, selectProject, setActiveView, setViewMode, tabs])
}
