import * as React from 'react'
import { cn } from '@/lib/utils'
import type { BackgroundTask } from '@/atoms/agent-atoms'
import { BackgroundTasksSummary } from './BackgroundTasksSummary'
import { useBackgroundTasks } from '@/hooks/useBackgroundTasks'

export interface ActiveTasksBarProps {
  sessionId: string
  tasks: BackgroundTask[]
  className?: string
}

/** 输入区上方仅保留一个紧凑入口，详情统一在独立后台任务面板查看。 */
export function ActiveTasksBar({
  sessionId,
  tasks,
  className,
}: ActiveTasksBarProps): React.ReactElement | null {
  // 输入区随会话常驻，用它恢复主进程快照；面板无需先打开才能看到后台任务入口。
  useBackgroundTasks(sessionId, { hydrate: false })
  const runningTasks = tasks.filter((task) => task.status === 'running')
  if (runningTasks.length === 0) return null

  return (
    <div className={cn('px-4 py-1', className)}>
      <BackgroundTasksSummary
        sessionId={sessionId}
        tasks={runningTasks}
        toolUseIds={runningTasks.map((task) => task.toolUseId)}
      />
    </div>
  )
}
