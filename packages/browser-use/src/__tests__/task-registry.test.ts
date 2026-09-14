import { describe, expect, test } from 'bun:test'
import { TaskRegistry } from '../task-registry.js'
import { captureSync } from './captureBrowserError.js'

describe('TaskRegistry', () => {
  test('tasks are isolated per session', () => {
    const registry = new TaskRegistry()
    registry.attach('session-a', 'main', { tabId: 1 })
    registry.attach('session-b', 'main', { tabId: 2 })

    expect(registry.get('session-a', 'main')?.tabId).toBe(1)
    expect(registry.get('session-b', 'main')?.tabId).toBe(2)
    expect(registry.list('session-a')).toHaveLength(1)
    expect(registry.list()).toHaveLength(2)
  })

  test('attach defaults to user-owned ownership', () => {
    const registry = new TaskRegistry()
    const task = registry.attach('s', 'main', { tabId: 5 })
    expect(task.ownership).toBe('user-owned')
    expect(task.status).toBe('attached')
  })

  test('re-attach preserves createdAt and explicit ownership', () => {
    const registry = new TaskRegistry()
    const first = registry.attach(
      's',
      'main',
      { tabId: 1 },
      {
        ownership: 'host-created',
        sessionTitle: '标题',
      },
    )
    const second = registry.attach('s', 'main', { tabId: 9 })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.ownership).toBe('host-created')
    expect(second.sessionTitle).toBe('标题')
    expect(second.tabId).toBe(9)
  })

  test('update patches task fields and bumps updatedAt', () => {
    const registry = new TaskRegistry()
    registry.attach('s', 'main', { tabId: 1, url: 'about:blank' })
    const updated = registry.update('s', 'main', { url: 'https://example.com' })
    expect(updated.url).toBe('https://example.com')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt)
  })

  test('require throws TASK_NOT_FOUND for unknown tasks', () => {
    const registry = new TaskRegistry()
    expect(captureSync(() => registry.require('s', 'missing')).code).toBe(
      'TASK_NOT_FOUND',
    )
  })

  test('remove deletes only the targeted session task', () => {
    const registry = new TaskRegistry()
    registry.attach('a', 'main', {})
    registry.attach('b', 'main', {})
    expect(registry.remove('a', 'main')).toBe(true)
    expect(registry.get('a', 'main')).toBeUndefined()
    expect(registry.get('b', 'main')).toBeDefined()
    expect(registry.remove('a', 'main')).toBe(false)
  })

  test('clear empties the registry', () => {
    const registry = new TaskRegistry()
    registry.attach('a', 'main', {})
    registry.attach('a', 'second', {})
    registry.clear()
    expect(registry.list()).toHaveLength(0)
  })

  test('attach without taskId is rejected', () => {
    const registry = new TaskRegistry()
    expect(captureSync(() => registry.attach('s', '')).code).toBe(
      'INVALID_PARAMS',
    )
  })
})
