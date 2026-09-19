import * as React from 'react'
import { Check, ChevronDown, ChevronRight, CircleStop, Loader2, X } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n'
import { groupBackgroundTasks } from '@/lib/background-task-presentation'
import { currentAgentSessionIdAtom, type BackgroundTask } from '@/atoms/agent-atoms'
import { useBackgroundTasks } from '@/hooks/useBackgroundTasks'
import type { GetTaskOutputResult } from '@proma/shared'

export interface BackgroundTasksPanelProps {
  tasks: BackgroundTask[]
  className?: string
}

function taskTypeLabel(task: BackgroundTask): string {
  return task.type === 'shell' ? 'Bash' : 'Agent'
}

function TaskStatusIcon({ status }: { status: BackgroundTask['status'] }): React.ReactElement {
  if (status === 'running') return <Loader2 className="size-3 animate-spin" />
  if (status === 'completed') return <Check className="size-3" />
  if (status === 'stopped') return <CircleStop className="size-3" />
  return <X className="size-3" />
}

const STATUS_KEYS: Record<BackgroundTask['status'], TranslationKey> = {
  running: 'backgroundTasks.status.running',
  completed: 'backgroundTasks.status.completed',
  failed: 'backgroundTasks.status.failed',
  stopped: 'backgroundTasks.status.stopped',
}

interface TaskRowProps {
  task: BackgroundTask
  canStop: boolean
  onRefreshOutput(taskId: string): Promise<GetTaskOutputResult>
  onStop(taskId: string, type: BackgroundTask['type']): Promise<void>
}

function TaskRow({ task, canStop, onRefreshOutput, onStop }: TaskRowProps): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const [stopError, setStopError] = React.useState<string>()
  const [outputUnavailable, setOutputUnavailable] = React.useState(false)
  const [outputError, setOutputError] = React.useState<string>()
  const statusLabel = t(STATUS_KEYS[task.status])
  const title = task.intent?.trim() || `${taskTypeLabel(task)} ${task.id}`
  const detail = task.output?.trim()

  React.useEffect(() => {
    if (!expanded) return
    let disposed = false
    const refresh = (): void => {
      void onRefreshOutput(task.id)
        .then((result) => {
          if (!disposed) {
            setOutputUnavailable(result.unavailableReason === 'runtime_output_read_unsupported')
            setOutputError(undefined)
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            const detail = error instanceof Error && error.message.trim() ? error.message : undefined
            setOutputError(detail ?? t('backgroundTasks.outputRefreshFailed'))
          }
        })
    }
    refresh()
    // 已结束任务也读取一次真实输出与能力说明，只有运行中任务持续轮询。
    if (task.status !== 'running') return () => { disposed = true }
    const timer = window.setInterval(() => {
      if (!disposed) refresh()
    }, 1_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [expanded, onRefreshOutput, task.id, task.status, t])

  const handleStop = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.stopPropagation()
    setStopping(true)
    setStopError(undefined)
    try {
      await onStop(task.id, task.type)
    } catch (error) {
      setStopError(error instanceof Error ? error.message : t('backgroundTasks.stopFailed'))
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-lg bg-muted/45">
      <div className="flex items-center hover:bg-muted/65">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">{title}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {taskTypeLabel(task)} {task.status === 'running' ? `${Math.max(0, Math.floor(task.elapsedSeconds)).toString().padStart(2, '0')}s` : ''}
          </span>
          <span className={cn(
            'flex shrink-0 items-center gap-1 text-[11px]',
            task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}>
            <TaskStatusIcon status={task.status} />
            {statusLabel}
          </span>
        </button>
        {canStop && task.status === 'running' && (
          <button
            type="button"
            className="mr-2 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:opacity-50"
            aria-label={t('backgroundTasks.stop')}
            disabled={stopping}
            onClick={(event) => { void handleStop(event) }}
          >
            {stopping ? <Loader2 className="size-3 animate-spin" /> : <CircleStop className="size-3" />}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-border/35 px-3 py-2.5">
          {task.command && (
            <div className="font-mono text-[11px] leading-5 text-foreground/70 whitespace-pre-wrap break-words">
              {task.command}
            </div>
          )}
          {detail ? (
            <div className="space-y-1.5">
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/55 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground/75">
                {detail}
              </pre>
              {outputUnavailable && (
                <p className="text-[10px] text-muted-foreground">
                  {t('backgroundTasks.summaryOnly')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {outputUnavailable
                ? t('backgroundTasks.outputUnavailable')
                : task.status === 'running'
                  ? t('backgroundTasks.noOutputYet')
                  : t('backgroundTasks.noOutput')}
            </p>
          )}
          {task.outputFile && (
            <p className="truncate font-mono text-[10px] text-muted-foreground" title={task.outputFile}>
              {t('backgroundTasks.outputFile')}: {task.outputFile}
            </p>
          )}
          {stopError && <p className="text-[11px] text-destructive">{stopError}</p>}
          {outputError && (
            <p className="text-[11px] text-destructive" role="status">
              {t('backgroundTasks.outputRefreshFailed')} {outputError === t('backgroundTasks.outputRefreshFailed') ? '' : outputError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface TaskGroupProps {
  title: string
  tasks: BackgroundTask[]
  canStopTask(taskId: string): boolean
  onRefreshOutput(taskId: string): Promise<GetTaskOutputResult>
  onStop(taskId: string, type: BackgroundTask['type']): Promise<void>
}

function TaskGroup({ title, tasks, canStopTask, onRefreshOutput, onStop }: TaskGroupProps): React.ReactElement | null {
  if (tasks.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title} <span className="tabular-nums">{tasks.length}</span>
      </h3>
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.toolUseId}
            task={task}
            canStop={canStopTask(task.id)}
            onRefreshOutput={onRefreshOutput}
            onStop={onStop}
          />
        ))}
      </div>
    </section>
  )
}

/** Claude Code 风格的会话后台任务详情：Running / Finished 两组紧凑可展开行。 */
export function BackgroundTasksPanel({ tasks, className }: BackgroundTasksPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const sessionId = useAtomValue(currentAgentSessionIdAtom) ?? ''
  const {
    canStopTask,
    clearFinished,
    refreshTaskOutput,
    stopTask,
  } = useBackgroundTasks(sessionId, { hydrate: false })
  const [finishedOpen, setFinishedOpen] = React.useState(false)
  const [clearingFinished, setClearingFinished] = React.useState(false)
  const [clearError, setClearError] = React.useState<string>()
  const groups = React.useMemo(() => groupBackgroundTasks(tasks), [tasks])
  const handleClearFinished = React.useCallback(async (): Promise<void> => {
    setClearingFinished(true)
    setClearError(undefined)
    try {
      await clearFinished()
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message : undefined
      setClearError(detail ?? t('backgroundTasks.clearFailed'))
    } finally {
      setClearingFinished(false)
    }
  }, [clearFinished, t])

  if (tasks.length === 0) {
    return (
      <div className={cn('flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground', className)}>
        {t('backgroundTasks.empty')}
      </div>
    )
  }

  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3', className)}>
      <div className="space-y-5">
        <TaskGroup
          title={t('backgroundTasks.running')}
          tasks={groups.running}
          canStopTask={canStopTask}
          onRefreshOutput={refreshTaskOutput}
          onStop={stopTask}
        />
        {groups.finished.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 px-0.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                aria-expanded={finishedOpen}
                onClick={() => setFinishedOpen((value) => !value)}
              >
                {finishedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {t('backgroundTasks.finished')} <span className="tabular-nums">{groups.finished.length}</span>
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={clearingFinished}
                onClick={() => { void handleClearFinished() }}
              >
                {clearingFinished && <Loader2 className="size-3 animate-spin" />}
                {t('backgroundTasks.clearFinished')}
              </button>
            </div>
            {clearError && (
              <p className="text-[11px] text-destructive" role="status">
                {t('backgroundTasks.clearFailed')}：{clearError}
              </p>
            )}
            {finishedOpen && (
              <div className="space-y-1.5">
                {groups.finished.map((task) => (
                  <TaskRow
                    key={task.toolUseId}
                    task={task}
                    canStop={false}
                    onRefreshOutput={refreshTaskOutput}
                    onStop={stopTask}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
