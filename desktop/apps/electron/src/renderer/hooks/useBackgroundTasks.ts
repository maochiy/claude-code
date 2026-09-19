/**
 * useBackgroundTasks — 后台任务管理 Hook
 *
 * 管理 Agent 会话的后台任务列表（Agent 任务和 Shell 任务）。
 * 职责：
 * - 添加/更新/移除后台任务
 * - 停止任务（通过 IPC）
 */

import { atom, useAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { useCallback, useEffect, useRef } from 'react'
import {
  backgroundTasksAtomFamily,
  type BackgroundTask,
} from '@/atoms/agent-atoms'
import type { GetTaskOutputResult } from '@proma/shared'
import {
  applyBackgroundTaskOutputResponse,
  reconcileBackgroundTaskSnapshot,
} from '@/lib/background-task-presentation'

export interface UseBackgroundTasksResult {
  /** 当前会话的后台任务列表 */
  tasks: BackgroundTask[]

  /** 添加后台任务 */
  addTask: (task: Omit<BackgroundTask, 'elapsedSeconds' | 'status'>) => void

  /** 更新任务进度 */
  updateTaskProgress: (toolUseId: string, elapsedSeconds: number) => void

  /** 移除后台任务 */
  removeTask: (toolUseId: string) => void

  /** 停止任务 */
  stopTask: (taskId: string, type: 'agent' | 'shell') => Promise<void>

  /** Runtime 是否支持真实停止该任务 */
  canStopTask: (taskId: string) => boolean

  /** 拉取 Runtime 最新任务输出 */
  refreshTaskOutput: (taskId: string) => Promise<GetTaskOutputResult>

  /** 清理已结束任务 */
  clearFinished: () => Promise<void>
}

const stoppableBackgroundTaskIdsAtomFamily = atomFamily((sessionId: string) => (
  atom<Set<string>>(new Set<string>())
))

/**
 * 后台任务管理 Hook
 *
 * @param sessionId - 会话 ID，用于隔离任务列表
 */
export function useBackgroundTasks(
  sessionId: string,
  options: { hydrate?: boolean } = {},
): UseBackgroundTasksResult {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))
  const [stoppableTaskIds, setStoppableTaskIds] = useAtom(
    stoppableBackgroundTaskIdsAtomFamily(sessionId),
  )
  const latestTasksRef = useRef(tasks)
  latestTasksRef.current = tasks
  const runningTaskKey = tasks
    .filter((task) => task.status === 'running')
    .map((task) => `${task.id}:${task.toolUseId}`)
    .sort()
    .join('|')

  useEffect(() => {
    if (options.hydrate === false || !sessionId || typeof window === 'undefined'
      || typeof window.electronAPI?.listBackgroundTasks !== 'function') return
    let cancelled = false
    const baseline = latestTasksRef.current
    void window.electronAPI.listBackgroundTasks({ sessionId })
      .then(({ tasks: snapshots }) => {
        if (cancelled) return
        setTasks((current) => reconcileBackgroundTaskSnapshot({
          baseline,
          current,
          snapshots,
        }))
        setStoppableTaskIds(new Set(
          snapshots.filter((task) => task.canStop).map((task) => task.id),
        ))
      })
      .catch((error: unknown) => {
        console.error('[useBackgroundTasks] 恢复后台任务快照失败:', error)
      })
    return () => {
      cancelled = true
    }
  }, [options.hydrate, runningTaskKey, sessionId, setTasks])

  /**
   * 添加后台任务
   *
   * 防止重复添加（根据 toolUseId 判断）。
   */
  const addTask = useCallback(
    (task: Omit<BackgroundTask, 'elapsedSeconds' | 'status'>) => {
      setTasks((prev) => {
        // 防止重复添加
        if (prev.some((t) => t.toolUseId === task.toolUseId)) {
          return prev
        }
        return [...prev, { ...task, elapsedSeconds: 0, status: 'running' }]
      })
    },
    [setTasks]
  )

  /**
   * 更新任务进度
   *
   * 通过 task_progress 事件更新 elapsedSeconds。
   */
  const updateTaskProgress = useCallback(
    (toolUseId: string, elapsedSeconds: number) => {
      setTasks((prev) =>
        prev.map((t) => (t.toolUseId === toolUseId ? { ...t, elapsedSeconds } : t))
      )
    },
    [setTasks]
  )

  /**
   * 移除后台任务
   *
   * 任务完成或被停止时调用。
   */
  const removeTask = useCallback(
    (toolUseId: string) => {
      setTasks((prev) => prev.filter((t) => t.toolUseId !== toolUseId))
    },
    [setTasks]
  )

  /**
   * 停止任务
   *
   * 通过 IPC 调用主进程停止任务。
   * 终态由 SDK 事件确认；调用成功本身不代表任务已经停止。
   */
  const stopTask = useCallback(
    async (taskId: string, type: 'agent' | 'shell') => {
      try {
        await window.electronAPI.stopTask({
          sessionId,
          taskId,
          type,
        })
      } catch (error) {
        console.error('[useBackgroundTasks] 停止任务失败:', error)
        throw error
      }
    },
    [sessionId]
  )

  const canStopTask = useCallback(
    (taskId: string) => stoppableTaskIds.has(taskId),
    [stoppableTaskIds],
  )

  const refreshTaskOutput = useCallback(
    async (taskId: string) => {
      const baseline = latestTasksRef.current.find((task) => task.id === taskId)
      const result = await window.electronAPI.getTaskOutput({
        sessionId,
        taskId,
        block: false,
      })
      setTasks((previous) => previous.map((task) => {
        if (task.id !== taskId) return task
        return applyBackgroundTaskOutputResponse({
          baseline,
          current: task,
          output: result.output,
        })
      }))
      return result
    },
    [sessionId, setTasks],
  )

  const clearFinished = useCallback(async () => {
    await window.electronAPI.clearFinishedBackgroundTasks({ sessionId })
    setTasks((previous) => previous.filter((task) => task.status === 'running'))
    setStoppableTaskIds((previous) => new Set(
      [...previous].filter((taskId) => tasks.some((task) => task.id === taskId && task.status === 'running')),
    ))
  }, [sessionId, setTasks, tasks])

  return {
    tasks,
    addTask,
    updateTaskProgress,
    removeTask,
    stopTask,
    canStopTask,
    refreshTaskOutput,
    clearFinished,
  }
}
