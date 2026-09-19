import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ChevronRight } from 'lucide-react'
import { openAgentSidePanelTabAtom } from '@/atoms/agent-atoms'
import type { BackgroundTask } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { useTranslation, type TranslationKey } from '@/lib/i18n'
import {
  selectTurnBackgroundTasks,
  summarizeBackgroundTasks,
} from '@/lib/background-task-presentation'

export interface BackgroundTasksSummaryProps {
  sessionId: string
  tasks: BackgroundTask[]
  /** 当前消息轮次。新 SDK 事件可直接据此关联。 */
  turnId?: string
  /** 当前消息轮次包含的工具调用；兼容没有 turnId 的历史事件。 */
  toolUseIds?: string[]
  className?: string
}

const STATUS_KEYS: Record<BackgroundTask['status'] | 'mixed', TranslationKey> = {
  running: 'backgroundTasks.summary.running',
  completed: 'backgroundTasks.summary.completed',
  failed: 'backgroundTasks.summary.failed',
  stopped: 'backgroundTasks.summary.stopped',
  mixed: 'backgroundTasks.summary.mixed',
}

/** 消息过程尾部的紧凑后台任务摘要，点击后打开当前会话的独立任务面板。 */
export function BackgroundTasksSummary({
  sessionId,
  tasks,
  turnId,
  toolUseIds,
  className,
}: BackgroundTasksSummaryProps): React.ReactElement | null {
  const { t } = useTranslation()
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const turnTasks = React.useMemo(
    () => selectTurnBackgroundTasks({ tasks, turnId, toolUseIds }),
    [tasks, toolUseIds, turnId],
  )
  const summary = summarizeBackgroundTasks(turnTasks)
  if (!summary) return null

  return (
    <button
      type="button"
      data-background-task-tag
      className={cn(
        'group inline-flex items-center gap-1 rounded-md bg-[#E8F1FF] px-2 py-1 text-[12px] font-medium text-[#1769D2]',
        'transition-colors hover:bg-[#D9E9FF] hover:text-[#0F5FC7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1769D2]/35',
        'dark:bg-[#1769D2]/20 dark:text-[#79AFFF] dark:hover:bg-[#1769D2]/28 dark:hover:text-[#A6C8FF]',
        className,
      )}
      onClick={() => openSidePanelTab({ sessionId, tab: 'tasks' })}
    >
      <span>{t(STATUS_KEYS[summary.status], { count: summary.count })}</span>
      <ChevronRight className="size-3 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}
