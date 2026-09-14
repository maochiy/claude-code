import { describe, expect, test } from 'bun:test'
import { BrowserError } from '../protocol.js'
import { BrowserBackend, DEFAULT_SESSION_ID } from '../backend.js'
import type { BackendClient } from '../backend.js'
import type { RequestExtra } from '../protocol.js'
import { captureAsync } from './captureBrowserError.js'

type RecordedCall = {
  method: string
  params: Record<string, unknown>
  extra: RequestExtra
}

class FakeClient implements BackendClient {
  calls: RecordedCall[] = []
  handler: (
    method: string,
    params: Record<string, unknown>,
    extra: RequestExtra,
  ) => unknown = () => ({})

  async request(
    method: string,
    params: Record<string, unknown> = {},
    extra: RequestExtra = {},
  ): Promise<unknown> {
    this.calls.push({ method, params: { ...params }, extra: { ...extra } })
    return this.handler(method, params, extra)
  }

  lastCall(): RecordedCall {
    expect(this.calls.length).toBeGreaterThan(0)
    return this.calls[this.calls.length - 1]!
  }
}

describe('BrowserBackend', () => {
  test('attach without tabId creates a host-owned background task', async () => {
    const client = new FakeClient()
    client.handler = (_method, _params, extra) => ({
      tab: { tabId: 11, url: 'about:blank' },
      ownership: 'host-created',
      reused: false,
      _extra: extra,
    })
    const backend = new BrowserBackend({ client })

    const task = await backend.attach({
      taskId: 'main',
      sessionId: 'session-1',
      sessionTitle: '我的会话',
    })

    const call = client.lastCall()
    expect(call.method).toBe('tabs.attach')
    expect(call.params).toEqual({})
    expect(call.extra).toEqual({
      taskId: 'main',
      sessionId: 'session-1',
      sessionTitle: '我的会话',
    })
    expect(task.tabId).toBe(11)
    expect(task.ownership).toBe('host-created')
    expect(task.reused).toBe(false)
    expect(task.sessionId).toBe('session-1')
  })

  test('attach with explicit tabId binds the user tab', async () => {
    const client = new FakeClient()
    client.handler = () => ({
      tab: { tabId: 42, url: 'https://example.com' },
      reused: true,
    })
    const backend = new BrowserBackend({ client })

    const task = await backend.attach({ taskId: 'main', tabId: 42 })

    expect(client.lastCall().params).toEqual({ tabId: 42 })
    expect(task.ownership).toBe('user-owned')
    expect(task.reused).toBe(true)
  })

  test('attach falls back to default sessionId when omitted', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    await backend.attach({ taskId: 'main' })
    expect(client.lastCall().extra.sessionId).toBe(DEFAULT_SESSION_ID)
  })

  test('navigate auto-creates task and tab for unknown tasks', async () => {
    const client = new FakeClient()
    client.handler = method =>
      method === 'tabs.create'
        ? { tab: { tabId: 7, url: 'https://example.com' } }
        : {}
    const backend = new BrowserBackend({ client })

    const result = await backend.navigate({
      taskId: 'main',
      url: 'https://example.com',
      sessionId: 'session-1',
    })

    expect(client.calls[0]?.method).toBe('tabs.create')
    expect(result.tabId).toBe(7)
    expect(result.url).toBe('https://example.com')
    const task = backend.registry.get('session-1', 'main')
    expect(task?.ownership).toBe('host-created')
    expect(task?.tabId).toBe(7)
  })

  test('navigate on an existing task reuses the bound tabId', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    backend.registry.attach('session-1', 'main', { tabId: 7 })

    await backend.navigate({
      taskId: 'main',
      url: 'https://example.com/page',
      sessionId: 'session-1',
    })

    const call = client.lastCall()
    expect(call.method).toBe('tabs.navigate')
    expect(call.params).toEqual({ url: 'https://example.com/page', tabId: 7 })
  })

  test('navigate without a bound tab throws TARGET_NOT_FOUND', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    backend.registry.attach('session-1', 'main', {})

    const error = await captureAsync(
      backend.navigate({
        taskId: 'main',
        url: 'https://example.com',
        sessionId: 'session-1',
      }),
    )
    expect(error.code).toBe('TARGET_NOT_FOUND')
  })

  test('getState merges the bound tabId', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    backend.registry.attach('session-1', 'main', { tabId: 7 })

    await backend.getState({ taskId: 'main', sessionId: 'session-1' })

    const call = client.lastCall()
    expect(call.method).toBe('page.getState')
    expect(call.params).toEqual({ tabId: 7 })
  })

  test('close closes host-created tabs and removes the task', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    backend.registry.attach(
      'session-1',
      'main',
      { tabId: 7 },
      {
        ownership: 'host-created',
      },
    )

    const outcome = await backend.close({
      taskId: 'main',
      sessionId: 'session-1',
    })

    expect(client.lastCall().method).toBe('tabs.closeCreated')
    expect(outcome.action).toBe('closed')
    expect(backend.registry.get('session-1', 'main')).toBeUndefined()
  })

  test('close detaches user-owned tabs instead of closing them', async () => {
    const client = new FakeClient()
    const backend = new BrowserBackend({ client })
    backend.registry.attach(
      'session-1',
      'main',
      { tabId: 9 },
      {
        ownership: 'user-owned',
      },
    )

    const outcome = await backend.close({
      taskId: 'main',
      sessionId: 'session-1',
    })

    expect(client.lastCall().method).toBe('tabs.detach')
    expect(outcome.action).toBe('detached')
  })

  test('listTasks only returns the requested session tasks', () => {
    const backend = new BrowserBackend({ client: new FakeClient() })
    backend.registry.attach('session-1', 'main', { tabId: 1 })
    backend.registry.attach('session-2', 'main', { tabId: 2 })

    const tasks = backend.listTasks({ sessionId: 'session-1' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.sessionId).toBe('session-1')
  })

  test('backend errors surface as BrowserError with extension codes', async () => {
    const client = new FakeClient()
    client.handler = () => {
      throw new BrowserError('STALE_REF', '元素引用已失效', {
        retryable: false,
      })
    }
    const backend = new BrowserBackend({ client })

    const error = await captureAsync(
      backend.getState({ taskId: 'main', sessionId: 's' }),
    )
    expect(error.code).toBe('STALE_REF')
  })
})
