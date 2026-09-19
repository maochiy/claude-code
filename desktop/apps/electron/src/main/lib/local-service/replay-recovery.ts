interface ReplayPendingControl {
  cliRequestId: string
  subtype: string
  request: Record<string, unknown>
  createdAt: number
}

interface ReplayBackgroundTask {
  taskId: string
  state: 'running' | 'completed' | 'failed' | 'stopped'
  updatedAt: number
}

export interface LocalServiceReplayResetSnapshot {
  activeRunId?: string
  pendingControls: ReplayPendingControl[]
  runningTaskIds: string[]
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function pendingControl(value: unknown): ReplayPendingControl | undefined {
  const candidate = objectRecord(value)
  const request = objectRecord(candidate?.request)
  if (!candidate || !request || typeof candidate.cliRequestId !== 'string' || !candidate.cliRequestId
    || typeof candidate.subtype !== 'string') return undefined
  return {
    cliRequestId: candidate.cliRequestId,
    subtype: candidate.subtype,
    request,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
  }
}

function backgroundTask(value: unknown): ReplayBackgroundTask | undefined {
  const candidate = objectRecord(value)
  if (!candidate || typeof candidate.taskId !== 'string' || !candidate.taskId
    || !['running', 'completed', 'failed', 'stopped'].includes(String(candidate.state))) return undefined
  return {
    taskId: candidate.taskId,
    state: candidate.state as ReplayBackgroundTask['state'],
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  }
}

/** replay_reset 的 payload 是断线后的权威快照；无效条目不能污染桌面投影。 */
export function parseReplayResetSnapshot(payload: Record<string, unknown>): LocalServiceReplayResetSnapshot {
  const pendingControls = Array.isArray(payload.pendingControls)
    ? payload.pendingControls.map(pendingControl).filter((item): item is ReplayPendingControl => item !== undefined)
    : []
  const tasks = Array.isArray(payload.tasks)
    ? payload.tasks.map(backgroundTask).filter((item): item is ReplayBackgroundTask => item !== undefined)
    : []
  return {
    ...(typeof payload.activeRunId === 'string' && payload.activeRunId
      ? { activeRunId: payload.activeRunId }
      : {}),
    pendingControls,
    runningTaskIds: tasks.filter(task => task.state === 'running').map(task => task.taskId),
  }
}
