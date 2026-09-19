import type {
  AgentStreamPayload,
  BackgroundTaskSnapshot,
  GetTaskOutputInput,
  GetTaskOutputResult,
  SDKBackgroundTaskSummary,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  StopTaskInput,
} from '@proma/shared'

interface BackgroundTaskRuntimeControl {
  canStopTask(sessionId: string, taskId: string): boolean
  stopTask(sessionId: string, taskId: string): Promise<void>
  readTaskOutput?(sessionId: string, taskId: string): Promise<string | null>
}

export interface BackgroundTaskServiceDependencies {
  appendMessages(sessionId: string, messages: SDKMessage[]): void
  loadMessages(sessionId: string): SDKMessage[]
  now(): number
}

interface ToolDetails {
  command?: string
  intent?: string
  type: BackgroundTaskSnapshot['type']
}

interface TaskRecord extends Omit<BackgroundTaskSnapshot, 'canStop'> {}

function terminalStatus(value: string | undefined): BackgroundTaskSnapshot['status'] | null {
  switch (value?.toLowerCase()) {
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

function taskType(value: string | undefined): BackgroundTaskSnapshot['type'] {
  return value && /bash|shell|command/i.test(value) ? 'shell' : 'agent'
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function messageTime(message: SDKMessage, fallback: number): number {
  const value = (message as Record<string, unknown>)._createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toolDetails(message: SDKMessage): Array<[string, ToolDetails]> {
  if (message.type !== 'assistant') return []
  const content = (message as { message?: { content?: unknown[] } }).message?.content
  if (!Array.isArray(content)) return []
  const details: Array<[string, ToolDetails]> = []
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== 'object') continue
    const block = rawBlock as Record<string, unknown>
    if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
    const name = typeof block.name === 'string' ? block.name : ''
    if (!/^(bash|shell|task|agent)$/i.test(name)) continue
    const input = block.input && typeof block.input === 'object'
      ? block.input as Record<string, unknown>
      : {}
    details.push([block.id, {
      type: taskType(name),
      command: nonEmpty(input.command),
      intent: nonEmpty(input.description) ?? nonEmpty(input.prompt),
    }])
  }
  return details
}

/**
 * 主进程后台任务注册表。
 *
 * 只投影 Runtime 已发送的消息；不会凭 UI 状态创造任务或把停止请求提前标成成功。
 */
export class BackgroundTaskService {
  private readonly tasks = new Map<string, Map<string, TaskRecord>>()
  private readonly toolDetailsBySession = new Map<string, Map<string, ToolDetails>>()
  private readonly persistedUuids = new Map<string, Set<string>>()
  private readonly clearedFinishedIds = new Map<string, Set<string>>()
  private readonly completionWaiters = new Map<string, Set<() => void>>()
  private runtimeControl: BackgroundTaskRuntimeControl | null = null

  constructor(private readonly dependencies: BackgroundTaskServiceDependencies) {}

  setRuntimeControl(control: BackgroundTaskRuntimeControl): void {
    this.runtimeControl = control
  }

  observeStreamPayload(sessionId: string, payload: AgentStreamPayload): void {
    if (payload.kind === 'sdk_message') {
      this.observeMessage(sessionId, payload.message, true)
      return
    }
    this.observePromaTaskEvent(sessionId, payload.event as unknown as Record<string, unknown>)
  }

  listTasks(sessionId: string): BackgroundTaskSnapshot[] {
    this.hydrateFinishedTasks(sessionId)
    const records = Array.from(this.tasks.get(sessionId)?.values() ?? [])
    return records
      .filter((task) => !this.clearedFinishedIds.get(sessionId)?.has(task.id))
      .map((task) => ({
        ...task,
        canStop: task.status === 'running'
          && (this.runtimeControl?.canStopTask(sessionId, task.id) ?? false),
      }))
      .sort((left, right) => left.startTime - right.startTime)
  }

  async getTaskOutput(input: GetTaskOutputInput): Promise<GetTaskOutputResult> {
    let task = this.findTask(input.sessionId, input.taskId)
    if (!task) throw new Error(`后台任务不存在: ${input.taskId}`)
    if (input.block === true && task.status === 'running') {
      await new Promise<void>((resolve) => {
        const key = this.waiterKey(input.sessionId, input.taskId)
        const waiters = this.completionWaiters.get(key) ?? new Set<() => void>()
        waiters.add(resolve)
        this.completionWaiters.set(key, waiters)
      })
      task = this.findTask(input.sessionId, input.taskId)
    }
    let fullOutputUnavailable = Boolean(task?.outputFile)
    if (task && this.runtimeControl?.readTaskOutput) {
      const output = await this.runtimeControl.readTaskOutput(
        input.sessionId,
        input.taskId,
      )
      if (output != null) {
        task.output = output
        task.updatedAt = this.dependencies.now()
        fullOutputUnavailable = false
      }
    }
    const output = task?.output ?? ''
    return {
      output,
      isComplete: task?.status !== 'running',
      isOutputAvailable: output.length > 0,
      unavailableReason: fullOutputUnavailable
        ? 'runtime_output_read_unsupported'
        : output ? undefined : 'not_reported',
    }
  }

  async stopTask(input: StopTaskInput): Promise<void> {
    const task = this.findTask(input.sessionId, input.taskId)
    if (!task) throw new Error(`后台任务不存在: ${input.taskId}`)
    if (task.status !== 'running') return
    if (!this.runtimeControl?.canStopTask(input.sessionId, input.taskId)) {
      throw new Error('当前 Runtime 不支持单独停止此后台任务。')
    }
    await this.runtimeControl.stopTask(input.sessionId, input.taskId)
    // 只有 Runtime 发出的 task_notification(stopped) 才能确认停止成功。
  }

  clearFinished(sessionId: string): void {
    const sessionTasks = this.tasks.get(sessionId)
    if (!sessionTasks) return
    const cleared = this.clearedFinishedIds.get(sessionId) ?? new Set<string>()
    for (const [taskId, task] of sessionTasks) {
      if (task.status === 'running') continue
      sessionTasks.delete(taskId)
      cleared.add(taskId)
    }
    this.clearedFinishedIds.set(sessionId, cleared)
  }

  private observeMessage(sessionId: string, message: SDKMessage, persistTaskMessage: boolean): void {
    for (const [toolUseId, details] of toolDetails(message)) {
      const sessionDetails = this.toolDetailsBySession.get(sessionId) ?? new Map<string, ToolDetails>()
      sessionDetails.set(toolUseId, details)
      this.toolDetailsBySession.set(sessionId, sessionDetails)
    }

    if (message.type === 'result') {
      for (const summary of (message as SDKResultMessage).background_tasks ?? []) {
        this.applyResultSummary(sessionId, summary, messageTime(message, this.dependencies.now()))
      }
      return
    }
    if (message.type !== 'system') return
    const system = message as SDKSystemMessage
    if (!['task_started', 'task_progress', 'task_notification'].includes(system.subtype ?? '')) return
    if (persistTaskMessage) this.persistTaskSystemMessage(sessionId, message)
    this.applyTaskSystemMessage(sessionId, system, messageTime(message, this.dependencies.now()))
  }

  /** 兼容宿主直接发送的任务事件；当前 Local CLI 也可能只发送 sdk_message。 */
  private observePromaTaskEvent(sessionId: string, event: Record<string, unknown>): void {
    const type = nonEmpty(event.type)
    if (!type || ![
      'task_backgrounded', 'task_started', 'task_progress', 'task_notification',
      'shell_backgrounded', 'shell_killed',
    ].includes(type)) return
    const timestamp = this.dependencies.now()
    const taskId = nonEmpty(event.taskId) ?? nonEmpty(event.shellId)
    if (!taskId) return
    const toolUseId = nonEmpty(event.toolUseId) ?? taskId
    if (type === 'task_notification') {
      this.applyTaskSystemMessage(sessionId, {
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        tool_use_id: toolUseId,
        status: nonEmpty(event.status),
        summary: nonEmpty(event.summary),
        output_file: nonEmpty(event.outputFile),
      }, timestamp)
      return
    }
    if (type === 'shell_killed') {
      this.applyTaskSystemMessage(sessionId, {
        type: 'system', subtype: 'task_notification', task_id: taskId,
        tool_use_id: toolUseId, task_type: 'shell', status: 'stopped', summary: '',
      }, timestamp)
      return
    }
    if (type === 'task_progress') {
      this.applyTaskSystemMessage(sessionId, {
        type: 'system', subtype: 'task_progress', task_id: taskId,
        tool_use_id: toolUseId, description: nonEmpty(event.description),
        last_tool_name: nonEmpty(event.lastToolName),
      }, timestamp)
      return
    }
    const shell = type === 'shell_backgrounded'
    const sessionDetails = this.toolDetailsBySession.get(sessionId) ?? new Map<string, ToolDetails>()
    sessionDetails.set(toolUseId, {
      type: shell ? 'shell' : 'agent',
      command: nonEmpty(event.command),
      intent: nonEmpty(event.intent) ?? nonEmpty(event.description),
    })
    this.toolDetailsBySession.set(sessionId, sessionDetails)
    this.applyTaskSystemMessage(sessionId, {
      type: 'system', subtype: 'task_started', task_id: taskId,
      tool_use_id: toolUseId, task_type: shell ? 'shell' : nonEmpty(event.taskType),
      description: nonEmpty(event.description) ?? nonEmpty(event.intent) ?? '',
    }, timestamp)
  }

  private applyTaskSystemMessage(sessionId: string, message: SDKSystemMessage, timestamp: number): void {
    const taskId = nonEmpty(message.task_id)
    if (!taskId) return
    const sessionTasks = this.tasks.get(sessionId) ?? new Map<string, TaskRecord>()
    const existing = sessionTasks.get(taskId)
    const toolUseId = nonEmpty(message.tool_use_id) ?? existing?.toolUseId ?? taskId
    const details = this.toolDetailsBySession.get(sessionId)?.get(toolUseId)

    if (message.subtype === 'task_started') {
      sessionTasks.set(taskId, {
        id: taskId,
        type: message.task_type ? taskType(message.task_type) : details?.type ?? 'agent',
        toolUseId,
        startTime: existing?.startTime ?? timestamp,
        updatedAt: timestamp,
        elapsedSeconds: existing?.elapsedSeconds ?? 0,
        status: existing?.status ?? 'running',
        intent: nonEmpty(message.description) ?? details?.intent ?? existing?.intent,
        command: details?.command ?? existing?.command,
        output: existing?.output,
        outputFile: existing?.outputFile,
        lastToolName: existing?.lastToolName,
        completedAt: existing?.completedAt,
      })
    } else if (message.subtype === 'task_progress') {
      const duration = message.usage?.duration_ms
      sessionTasks.set(taskId, {
        id: taskId,
        type: existing?.type ?? details?.type ?? 'agent',
        toolUseId,
        startTime: existing?.startTime ?? timestamp,
        updatedAt: timestamp,
        elapsedSeconds: typeof duration === 'number'
          ? duration / 1000
          : existing?.elapsedSeconds ?? 0,
        status: existing?.status ?? 'running',
        intent: nonEmpty(message.description) ?? existing?.intent ?? details?.intent,
        command: existing?.command ?? details?.command,
        output: nonEmpty(message.summary) ?? existing?.output,
        outputFile: existing?.outputFile,
        lastToolName: nonEmpty(message.last_tool_name) ?? existing?.lastToolName,
        completedAt: existing?.completedAt,
      })
    } else if (message.subtype === 'task_notification') {
      const status = terminalStatus(message.status)
      if (!status) return
      const duration = message.usage?.duration_ms
      sessionTasks.set(taskId, {
        id: taskId,
        type: existing?.type ?? details?.type ?? 'agent',
        toolUseId,
        startTime: existing?.startTime ?? timestamp,
        updatedAt: timestamp,
        elapsedSeconds: typeof duration === 'number'
          ? duration / 1000
          : existing?.elapsedSeconds ?? 0,
        status,
        intent: existing?.intent ?? details?.intent,
        command: existing?.command ?? details?.command,
        output: nonEmpty(message.summary) ?? existing?.output,
        outputFile: nonEmpty(message.output_file) ?? existing?.outputFile,
        lastToolName: nonEmpty(message.last_tool_name) ?? existing?.lastToolName,
        completedAt: timestamp,
      })
      this.resolveWaiters(sessionId, taskId)
    }
    this.tasks.set(sessionId, sessionTasks)
  }

  private applyResultSummary(sessionId: string, summary: SDKBackgroundTaskSummary, timestamp: number): void {
    const taskId = nonEmpty(summary.id)
    if (!taskId) return
    const status = terminalStatus(summary.status)
      ?? (summary.status.toLowerCase() === 'running' ? 'running' : null)
    if (!status) return
    const sessionTasks = this.tasks.get(sessionId) ?? new Map<string, TaskRecord>()
    const existing = sessionTasks.get(taskId)
    sessionTasks.set(taskId, {
      id: taskId,
      type: existing?.type ?? taskType(summary.type),
      toolUseId: existing?.toolUseId ?? taskId,
      startTime: existing?.startTime ?? timestamp,
      updatedAt: timestamp,
      elapsedSeconds: existing?.elapsedSeconds ?? 0,
      status,
      intent: nonEmpty(summary.description) ?? nonEmpty(summary.name) ?? existing?.intent,
      command: nonEmpty(summary.command) ?? existing?.command,
      output: existing?.output,
      outputFile: existing?.outputFile,
      lastToolName: existing?.lastToolName,
      completedAt: status === 'running' ? existing?.completedAt : existing?.completedAt ?? timestamp,
    })
    this.tasks.set(sessionId, sessionTasks)
    if (status !== 'running') this.resolveWaiters(sessionId, taskId)
  }

  private hydrateFinishedTasks(sessionId: string): void {
    let messages: SDKMessage[]
    try {
      messages = this.dependencies.loadMessages(sessionId)
    } catch {
      return
    }
    const starts = new Map<string, { timestamp: number; message: SDKSystemMessage }>()
    for (const message of messages) {
      const timestamp = messageTime(message, 0)
      if (message.type === 'system') {
        const system = message as SDKSystemMessage
        if (system.subtype === 'task_started' && system.task_id) {
          starts.set(system.task_id, { timestamp, message: system })
          continue
        }
        if (system.subtype === 'task_notification' && system.task_id && terminalStatus(system.status)) {
          const started = starts.get(system.task_id)
          if (started && !this.tasks.get(sessionId)?.has(system.task_id)) {
            this.applyTaskSystemMessage(sessionId, started.message, started.timestamp)
          }
          if (!this.tasks.get(sessionId)?.has(system.task_id)
            || this.tasks.get(sessionId)?.get(system.task_id)?.status === 'running') {
            this.applyTaskSystemMessage(sessionId, system, timestamp)
          }
        }
      } else if (message.type === 'result') {
        for (const summary of (message as SDKResultMessage).background_tasks ?? []) {
          if (terminalStatus(summary.status) && !this.tasks.get(sessionId)?.has(summary.id)) {
            this.applyResultSummary(sessionId, summary, timestamp)
          }
        }
      }
    }
  }

  private persistTaskSystemMessage(sessionId: string, message: SDKMessage): void {
    const uuid = nonEmpty((message as Record<string, unknown>).uuid)
    let known = this.persistedUuids.get(sessionId)
    if (!known) {
      known = new Set(
        this.dependencies.loadMessages(sessionId)
          .map((item) => nonEmpty((item as Record<string, unknown>).uuid))
          .filter((item): item is string => Boolean(item)),
      )
      this.persistedUuids.set(sessionId, known)
    }
    if (uuid && known.has(uuid)) return
    this.dependencies.appendMessages(sessionId, [message])
    if (uuid) known.add(uuid)
  }

  private findTask(sessionId: string, taskId: string): TaskRecord | undefined {
    this.hydrateFinishedTasks(sessionId)
    return this.tasks.get(sessionId)?.get(taskId)
  }

  private waiterKey(sessionId: string, taskId: string): string {
    return `${sessionId}\u0000${taskId}`
  }

  private resolveWaiters(sessionId: string, taskId: string): void {
    const key = this.waiterKey(sessionId, taskId)
    const waiters = this.completionWaiters.get(key)
    if (!waiters) return
    this.completionWaiters.delete(key)
    for (const resolve of waiters) resolve()
  }
}
