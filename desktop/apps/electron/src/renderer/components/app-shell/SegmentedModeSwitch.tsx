/**
 * SegmentedModeSwitch - Cowork/Code 分段切换器（Claude 桌面端样式）
 *
 * 替换原 ModeSwitcher 下拉弹窗：整宽胶囊容器内两个分段，
 * 激活分段浮起（卡片底 + 柔和阴影）。映射关系：Cowork → chat，Code → agent。
 * 切换模式时恢复上一次在该模式下查看的对话/会话（逻辑与 ModeSwitcher 一致）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowRightLeft, CodeXml } from 'lucide-react'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { tabsAtom } from '@/atoms/tab-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

interface SegmentOption {
  value: AppMode
  labelKey: 'mode.cowork' | 'mode.code'
  icon: React.ReactNode
}

const segments: SegmentOption[] = [
  { value: 'chat', labelKey: 'mode.cowork', icon: <ArrowRightLeft size={13} /> },
  { value: 'agent', labelKey: 'mode.code', icon: <CodeXml size={14} /> },
]

export function SegmentedModeSwitch(): React.ReactElement {
  const { t } = useTranslation()
  const [mode, setMode] = useAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setViewMode = useSetAtom(sidebarViewModeAtom)
  const openSession = useOpenSession()
  const conversations = useAtomValue(conversationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentConversationId = useAtomValue(currentConversationIdAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const tabs = useAtomValue(tabsAtom)

  const restoreSession = React.useCallback((targetMode: AppMode) => {
    const isChatMode = targetMode === 'chat'
    const sessions = isChatMode ? conversations : agentSessions
    const lastId = isChatMode ? currentConversationId : currentAgentSessionId
    const hasOpenSessionTab = tabs.some((tab) => tab.type === 'chat' || tab.type === 'agent')

    // 主页空态下只切换模式，不自动打开上次会话。
    if (!hasOpenSessionTab) {
      setMode(targetMode)
      return
    }

    if (lastId) {
      const match = sessions.find((s) => s.id === lastId)
      if (match) {
        openSession(targetMode, match.id, match.title)
        return
      }
    }
    const tab = tabs.find((t) => t.type === targetMode)
    if (tab) {
      openSession(targetMode, tab.sessionId, tab.title)
      return
    }
    const recent = sessions.find((s) => !s.archived)
    if (recent) {
      openSession(targetMode, recent.id, recent.title)
      return
    }
    setMode(targetMode)
  }, [openSession, conversations, agentSessions, currentConversationId, currentAgentSessionId, tabs, setMode])

  const handleSwitch = React.useCallback((targetMode: AppMode) => {
    if (targetMode === mode) return
    // 与原切换一致：回到会话列表 active 视图
    setViewMode('active')
    setActiveView('conversations')
    restoreSession(targetMode)
  }, [mode, restoreSession, setActiveView, setViewMode])

  return (
    <div
      role="tablist"
      aria-label={t('mode.switch')}
      className="titlebar-no-drag flex w-full select-none items-center rounded-[8px] bg-foreground/[0.055] p-px"
    >
      {segments.map((segment) => {
        const active = mode === segment.value
        return (
          <button
            key={segment.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => handleSwitch(segment.value)}
            className={cn(
              'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[13px] transition-[background-color,color,box-shadow] duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active
                ? 'bg-[var(--mode-selected-background)] text-foreground shadow-[0_1px_2px_rgb(60_50_30/0.08)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className={cn(active ? 'text-foreground/70' : 'text-muted-foreground/80')}>
              {segment.icon}
            </span>
            {t(segment.labelKey)}
          </button>
        )
      })}
    </div>
  )
}
