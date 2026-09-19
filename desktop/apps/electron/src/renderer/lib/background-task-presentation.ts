import type { BackgroundTask } from '@/atoms/agent-atoms'
import type {
  BackgroundTaskSnapshot,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@proma/shared'

export type BackgroundTaskStatus = BackgroundTask['status']

export interface BackgroundTaskGroups {
  running: BackgroundTask[]
  finished: BackgroundTask[]
}

export interface BackgroundTaskSummary {
  count: number
  status: BackgroundTaskStatus | 'mixed'
}

export function snapshotToBackgroundTask(snapshot: BackgroundTaskSnapshot): BackgroundTask {
  return {
    id: snapshot.id,
    type: snapshot.type,
    toolUseId: snapshot.toolUseId,
    turnId: snapshot.turnId,
    startTime: snapshot.startTime,
    elapsedSeconds: snapshot.elapsedSeconds,
    status: snapshot.status,
    intent: snapshot.intent,
    command: snapshot.command,
    output: snapshot.output,
    outputFile: snapshot.outputFile,
    lastToolName: snapshot.lastToolName,
    completedAt: snapshot.completedAt,
  }
}

function taskIdentity(task: Pick<BackgroundTask, 'id' | 'toolUseId'>): string {
  return `${task.id}\u0000${task.toolUseId}`
}

/**
 * IPC 请求期间到达的实时事件优先于请求发起前的快照。
 * 同时允许主进程快照删除已清理的旧 Finished 记录。
 */
export function reconcileBackgroundTaskSnapshot(input: {
  baseline: BackgroundTask[]
  current: BackgroundTask[]
  snapshots: BackgroundTaskSnapshot[]
}): BackgroundTask[] {
  const baseline = new Map(input.baseline.map((task) => [taskIdentity(task), task]))
  const current = new Map(input.current.map((task) => [taskIdentity(task), task]))
  const removedDuringRequest = new Set(
    [...baseline.keys()].filter((key) => !current.has(key)),
  )
  const reconciled = input.snapshots
    .map(snapshotToBackgroundTask)
    .filter((task) => !removedDuringRequest.has(taskIdentity(task)))
  const indexByIdentity = new Map(
    reconciled.map((task, index) => [taskIdentity(task), index]),
  )

  for (const task of input.current) {
    const key = taskIdentity(task)
    const beforeRequest = baseline.get(key)
    if (beforeRequest === task) continue
    const index = indexByIdentity.get(key)
    if (index === undefined) {
      indexByIdentity.set(key, reconciled.length)
      reconciled.push(task)
      continue
    }
    const snapshot = reconciled[index]!
    reconciled[index] = {
      ...snapshot,
      ...task,
      intent: task.intent ?? snapshot.intent,
      command: task.command ?? snapshot.command,
      output: task.output ?? snapshot.output,
      outputFile: task.outputFile ?? snapshot.outputFile,
      lastToolName: task.lastToolName ?? snapshot.lastToolName,
    }
  }
  return reconciled.sort((left, right) => left.startTime - right.startTime)
}

/** 慢输出响应不得覆盖请求期间由实时事件写入的新输出。 */
export function applyBackgroundTaskOutputResponse(input: {
  baseline?: BackgroundTask
  current: BackgroundTask
  output: string
}): BackgroundTask {
  if (!input.output || (input.baseline && input.current !== input.baseline)) {
    return input.current
  }
  return { ...input.current, output: input.output }
}

/** Running 与 Finished 是后台任务面板唯一的两个分组。 */
export function groupBackgroundTasks(tasks: BackgroundTask[]): BackgroundTaskGroups {
  return {
    running: tasks.filter((task) => task.status === 'running'),
    finished: tasks.filter((task) => task.status !== 'running').sort((left, right) => (
      (right.completedAt ?? right.startTime) - (left.completedAt ?? left.startTime)
    )),
  }
}

/**
 * 消息尾部只汇总属于当前轮次的后台任务。
 * toolUseIds 优先，因为旧 SDK 消息不一定携带 turnId。
 */
export function selectTurnBackgroundTasks(input: {
  tasks: BackgroundTask[]
  turnId?: string
  toolUseIds?: string[]
}): BackgroundTask[] {
  const ids = new Set(input.toolUseIds ?? [])
  return input.tasks.filter((task) => (
    ids.has(task.toolUseId)
    || Boolean(input.turnId && task.turnId === input.turnId)
  ))
}

/** 只有所有任务状态相同时才给整组附加状态，避免把混合终态错误描述成全部失败或停止。 */
export function summarizeBackgroundTasks(tasks: BackgroundTask[]): BackgroundTaskSummary | null {
  if (tasks.length === 0) return null
  const statuses = new Set(tasks.map((task) => task.status))
  return {
    count: tasks.length,
    status: statuses.size === 1 ? tasks[0]!.status : 'mixed',
  }
}

/** 工具结果只接受真实字符串或可序列化值，不生成推测性输出。 */
export function toBackgroundTaskOutput(result: unknown): string | undefined {
  if (typeof result === 'string') return result.trim() || undefined
  if (result == null) return undefined
  try {
    const serialized = JSON.stringify(result, null, 2)
    return serialized === '{}' || serialized === '[]' ? undefined : serialized
  } catch {
    return undefined
  }
}

function messageTimestamp(message: SDKMessage, fallback: number): number {
  const value = (message as Record<string, unknown>)._createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizePersistedStatus(status: string | undefined): Exclude<BackgroundTaskStatus, 'running'> | null {
  switch (status?.toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'success':
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

function persistedTaskType(value: string | undefined): BackgroundTask['type'] {
  return value && /bash|shell|command/i.test(value) ? 'shell' : 'agent'
}

interface PersistedTaskStart {
  taskId: string
  toolUseId: string
  startTime: number
  intent?: string
  type: BackgroundTask['type']
}

/**
 * 从已落盘 SDK 消息恢复明确结束的后台任务。
 * 只有 task_notification 或 result.background_tasks 中的明确终态会进入结果；
 * 单独的 started/progress 不会在应用重启后被猜成仍在运行。
 */
export function projectPersistedBackgroundTasks(messages: SDKMessage[]): BackgroundTask[] {
  const starts = new Map<string, PersistedTaskStart>()
  const projected = new Map<string, BackgroundTask>()

  messages.forEach((message, index) => {
    const timestamp = messageTimestamp(message, index)
    if (message.type === 'system') {
      const system = message as SDKSystemMessage
      if (system.subtype === 'task_started' && system.task_id) {
        starts.set(system.task_id, {
          taskId: system.task_id,
          toolUseId: system.tool_use_id ?? system.task_id,
          startTime: timestamp,
          intent: system.description,
          type: persistedTaskType(system.task_type),
        })
        return
      }
      if (system.subtype === 'task_progress' && system.task_id) {
        const existing = starts.get(system.task_id)
        if (existing && system.description) {
          starts.set(system.task_id, { ...existing, intent: system.description })
        }
        return
      }
      if (system.subtype !== 'task_notification' || !system.task_id) return
      const status = normalizePersistedStatus(system.status)
      if (!status) return
      const started = starts.get(system.task_id)
      const toolUseId = system.tool_use_id ?? started?.toolUseId ?? system.task_id
      projected.set(system.task_id, {
        id: system.task_id,
        type: started?.type ?? 'agent',
        toolUseId,
        startTime: started?.startTime ?? timestamp,
        elapsedSeconds: system.usage?.duration_ms ? system.usage.duration_ms / 1000 : 0,
        status,
        intent: started?.intent,
        output: system.summary?.trim() || undefined,
        outputFile: system.output_file,
        lastToolName: system.last_tool_name,
        completedAt: timestamp,
      })
      return
    }

    if (message.type !== 'result') return
    const result = message as SDKResultMessage
    for (const summary of result.background_tasks ?? []) {
      const status = normalizePersistedStatus(summary.status)
      if (!status) continue
      const existing = projected.get(summary.id)
      const started = starts.get(summary.id)
      projected.set(summary.id, {
        id: summary.id,
        type: persistedTaskType(summary.type),
        toolUseId: existing?.toolUseId ?? started?.toolUseId ?? summary.id,
        startTime: existing?.startTime ?? started?.startTime ?? timestamp,
        elapsedSeconds: existing?.elapsedSeconds ?? 0,
        status,
        intent: summary.description || summary.name || existing?.intent || started?.intent,
        command: summary.command || existing?.command,
        output: existing?.output,
        outputFile: existing?.outputFile,
        completedAt: existing?.completedAt ?? timestamp,
      })
    }
  })

  return Array.from(projected.values()).sort((left, right) => left.startTime - right.startTime)
}

/** 历史终态提供基线，实时任务始终覆盖同一任务的历史快照。 */
export function mergeBackgroundTaskHistory(
  history: BackgroundTask[],
  live: BackgroundTask[],
): BackgroundTask[] {
  const merged = [...history]
  for (const liveTask of live) {
    const index = merged.findIndex((task) => (
      task.id === liveTask.id || task.toolUseId === liveTask.toolUseId
    ))
    if (index < 0) {
      merged.push(liveTask)
      continue
    }
    const historicalTask = merged[index]!
    merged[index] = {
      ...historicalTask,
      ...liveTask,
      intent: liveTask.intent ?? historicalTask.intent,
      command: liveTask.command ?? historicalTask.command,
      output: liveTask.output ?? historicalTask.output,
      outputFile: liveTask.outputFile ?? historicalTask.outputFile,
    }
  }
  return merged.sort((left, right) => left.startTime - right.startTime)
}
