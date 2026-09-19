import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BackgroundTask } from '@/atoms/agent-atoms'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import { ActiveTasksBar } from './ActiveTasksBar'

function createTask(overrides: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 'task-1',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: 100,
    elapsedSeconds: 4,
    status: 'running',
    intent: '检查构建结果',
    ...overrides,
  }
}

describe('后台任务面板', () => {
  test('Given 会话同时包含运行和已结束任务 When 渲染面板 Then 使用两组紧凑任务行且不使用表格', () => {
    const html = renderToStaticMarkup(
      <BackgroundTasksPanel tasks={[
        createTask({ id: 'running', toolUseId: 'running' }),
        createTask({
          id: 'finished',
          toolUseId: 'finished',
          type: 'shell',
          status: 'completed',
          command: 'bun run build',
          output: 'build passed',
          completedAt: 200,
        }),
      ]} />,
    )

    expect(html).toContain('运行中')
    expect(html).toContain('已结束')
    expect(html).toContain('清除已结束任务')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('<table')
  })

  test('Given 当前会话没有后台任务 When 渲染面板 Then 显示真实空态', () => {
    const html = renderToStaticMarkup(<BackgroundTasksPanel tasks={[]} />)
    expect(html).toContain('当前会话没有后台任务')
  })

  test('Given 输入区上方有多个运行任务 When 渲染入口 Then 只显示一个紧凑摘要按钮', () => {
    const html = renderToStaticMarkup(
      <ActiveTasksBar
        sessionId="session-1"
        tasks={[
          createTask({ id: 'one', toolUseId: 'one' }),
          createTask({ id: 'two', toolUseId: 'two' }),
        ]}
      />,
    )

    expect(html).toContain('2 个后台任务正在运行')
    expect(html).toContain('data-background-task-tag="true"')
    expect(html).toContain('bg-[#E8F1FF]')
    expect((html.match(/<button/g) ?? [])).toHaveLength(1)
  })
})
