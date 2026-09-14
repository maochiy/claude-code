import { getBrowserClient } from './socket-client.js'
import { BrowserError, type RequestExtra } from './protocol.js'
import {
  TaskRegistry,
  type TaskOwnership,
  type TaskRecord,
} from './task-registry.js'

export const DEFAULT_SESSION_ID = 'default'

export type BrowserScope = {
  taskId?: string | null
  sessionId?: string | null
  sessionTitle?: string | null
}

/** 最小 client 接口，测试可注入内存 fake。 */
export type BackendClient = {
  request(
    method: string,
    params?: Record<string, unknown>,
    extra?: RequestExtra,
  ): Promise<unknown>
}

type AttachArgs = BrowserScope & {
  taskId: string
  tabId?: number | null
  title?: string
}

type NavigateArgs = BrowserScope & {
  taskId: string
  url: string
  title?: string
}

type CloseArgs = BrowserScope & { taskId: string }

type AttachResult = {
  tab?: {
    tabId?: number
    id?: number
    windowId?: number
    url?: string
    title?: string
  }
  tabId?: number
  ownership?: TaskOwnership
  reused?: boolean
}

type NavigateResult = {
  tab?: { tabId?: number; id?: number; url?: string; title?: string }
  tabId?: number
  ownership?: TaskOwnership
  reused?: boolean
  url?: string
  title?: string
}

/**
 * 扩展后端：所有请求都带上 (taskId, sessionId, sessionTitle)，
 * 由 Chrome 扩展把标签放进「会话名」命名的标签组，并在后台（CDP）执行页面操作。
 */
export class BrowserBackend {
  readonly registry: TaskRegistry
  private readonly client: BackendClient

  constructor(
    options: { client?: BackendClient; registry?: TaskRegistry } = {},
  ) {
    this.client = options.client ?? getBrowserClient()
    this.registry = options.registry ?? new TaskRegistry()
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    scope: BrowserScope = {},
  ): Promise<unknown> {
    const extra: RequestExtra = {
      taskId: scope.taskId ?? null,
      sessionId: scope.sessionId || DEFAULT_SESSION_ID,
      sessionTitle: scope.sessionTitle || '',
    }
    return this.client.request(method, params, extra)
  }

  /** 带上任务已绑定的 tabId 发起请求。 */
  call(
    method: string,
    params: Record<string, unknown>,
    scope: BrowserScope & { taskId?: string | null },
  ): Promise<unknown> {
    const task = scope.taskId
      ? this.registry.get(scope.sessionId || undefined, scope.taskId)
      : undefined
    const merged =
      task?.tabId != null ? { ...params, tabId: task.tabId } : { ...params }
    return this.request(method, merged, scope)
  }

  /** 确保会话拥有可用的后台标签并绑定任务；显式 tabId 才附加用户已有标签页。 */
  async attach(args: AttachArgs): Promise<TaskRecord & { reused: boolean }> {
    const { taskId, tabId, title = '', sessionId, sessionTitle = '' } = args
    const result = (await this.request(
      'tabs.attach',
      tabId == null ? {} : { tabId },
      { taskId, sessionId, sessionTitle },
    )) as AttachResult | undefined
    const ownership: TaskOwnership =
      result?.ownership || (tabId == null ? 'host-created' : 'user-owned')
    const task = this.registry.attach(
      sessionId,
      taskId,
      result?.tab || (result as { tabId?: number } | undefined) || {},
      { title, sessionTitle: sessionTitle || '', ownership },
    )
    return { ...task, reused: !!result?.reused }
  }

  async navigate(args: NavigateArgs): Promise<Record<string, unknown>> {
    const { taskId, title = '', url, sessionId, sessionTitle = '' } = args
    let task = this.registry.get(sessionId, taskId)
    if (!task) {
      const result = (await this.request(
        'tabs.create',
        { url },
        {
          taskId,
          sessionId,
          sessionTitle,
        },
      )) as NavigateResult | undefined
      task = this.registry.attach(sessionId, taskId, result?.tab || {}, {
        title,
        sessionTitle: sessionTitle || '',
        ownership: 'host-created',
      })
      this.registry.update(sessionId, taskId, {
        title: title || task.title,
        url: result?.tab?.url || url,
      })
      return {
        taskId,
        sessionId: sessionId || DEFAULT_SESSION_ID,
        sessionTitle,
        tabId: task.tabId,
        url: result?.tab?.url || url,
        title: title || result?.tab?.title || '',
      }
    }
    if (task.tabId == null) {
      throw new BrowserError('TARGET_NOT_FOUND', 'No tab is bound to this task')
    }
    const result = (await this.call(
      'tabs.navigate',
      { url },
      { taskId, sessionId, sessionTitle },
    )) as NavigateResult | undefined
    this.registry.update(sessionId, taskId, {
      title: title || task.title,
      url: result?.url || url,
      sessionTitle: sessionTitle || '',
    })
    return { ...(result || {}), taskId, tabId: task.tabId }
  }

  getState(scope: BrowserScope & { taskId: string }): Promise<unknown> {
    return this.call('page.getState', {}, scope)
  }

  action(
    method: string,
    args: Record<string, unknown> & BrowserScope,
  ): Promise<unknown> {
    const { taskId, sessionId, sessionTitle, ...params } = args
    return this.call(method, params, { taskId, sessionId, sessionTitle })
  }

  listTasks(scope: { sessionId?: string | null } = {}): TaskRecord[] {
    return this.registry.list(scope.sessionId || undefined)
  }

  listTabs(scope: BrowserScope = {}): Promise<unknown> {
    return this.request('tabs.list', {}, scope)
  }

  listSessions(scope: BrowserScope = {}): Promise<unknown> {
    return this.request('sessions.list', {}, scope)
  }

  async close(args: CloseArgs): Promise<Record<string, unknown>> {
    const { taskId, sessionId, sessionTitle = '' } = args
    const task = this.registry.require(sessionId, taskId)
    const method =
      task.ownership === 'host-created' ? 'tabs.closeCreated' : 'tabs.detach'
    const result = await this.call(
      method,
      {},
      { taskId, sessionId, sessionTitle },
    )
    this.registry.remove(sessionId, taskId)
    return {
      result: result as Record<string, unknown>,
      action: method === 'tabs.detach' ? 'detached' : 'closed',
    }
  }
}
