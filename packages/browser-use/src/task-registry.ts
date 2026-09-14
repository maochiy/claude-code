import { BrowserError } from './protocol.js'

const SEPARATOR = '\u0000'

export type TaskOwnership = 'host-created' | 'user-owned'

export type TaskRecord = {
  taskId: string
  sessionId: string
  sessionTitle: string
  tabId: number | null
  windowId: number | null
  title: string
  url: string
  ownership: TaskOwnership
  status: 'attached'
  createdAt: number
  updatedAt: number
}

type AttachTab = {
  tabId?: number | null
  id?: number | null
  windowId?: number | null
  title?: string
  url?: string
}

/**
 * 任务表：taskId 只在所属会话内有意义，因此主键是 (sessionId, taskId)。
 * 不同 ccx 会话使用同名 taskId 时各自拥有独立的任务与标签页。
 */
export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>()

  static key(sessionId: string | null | undefined, taskId: string): string {
    return (sessionId || 'default') + SEPARATOR + taskId
  }

  attach(
    sessionId: string | null | undefined,
    taskId: string,
    tab: AttachTab = {},
    options: {
      sessionTitle?: string
      title?: string
      ownership?: TaskOwnership
    } = {},
  ): TaskRecord {
    if (!taskId) {
      throw new BrowserError('INVALID_PARAMS', 'taskId is required')
    }
    const key = TaskRegistry.key(sessionId, taskId)
    const old = this.tasks.get(key)
    const now = Date.now()
    const task: TaskRecord = {
      taskId,
      sessionId: sessionId || 'default',
      sessionTitle: options.sessionTitle || old?.sessionTitle || '',
      tabId: tab.tabId ?? tab.id ?? old?.tabId ?? null,
      windowId: tab.windowId ?? old?.windowId ?? null,
      title: options.title || tab.title || old?.title || '',
      url: tab.url || old?.url || '',
      ownership: options.ownership || old?.ownership || 'user-owned',
      status: 'attached',
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    }
    this.tasks.set(key, task)
    return { ...task }
  }

  get(
    sessionId: string | null | undefined,
    taskId: string,
  ): TaskRecord | undefined {
    const task = this.tasks.get(TaskRegistry.key(sessionId, taskId))
    return task ? { ...task } : undefined
  }

  require(sessionId: string | null | undefined, taskId: string): TaskRecord {
    const task = this.tasks.get(TaskRegistry.key(sessionId, taskId))
    if (!task) {
      throw new BrowserError(
        'TASK_NOT_FOUND',
        `Unknown browser task: ${taskId}`,
        {
          details: { taskId, sessionId: sessionId || 'default' },
        },
      )
    }
    return task
  }

  update(
    sessionId: string | null | undefined,
    taskId: string,
    patch: Partial<Omit<TaskRecord, 'taskId' | 'sessionId' | 'createdAt'>>,
  ): TaskRecord {
    const task = this.require(sessionId, taskId)
    Object.assign(task, patch, { updatedAt: Date.now() })
    return { ...task }
  }

  remove(sessionId: string | null | undefined, taskId: string): boolean {
    return this.tasks.delete(TaskRegistry.key(sessionId, taskId))
  }

  list(sessionId?: string): TaskRecord[] {
    return [...this.tasks.values()]
      .filter(task => !sessionId || task.sessionId === sessionId)
      .map(task => ({ ...task }))
  }

  clear(): void {
    this.tasks.clear()
  }
}
