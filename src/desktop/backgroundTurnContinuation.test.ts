import { describe, expect, test } from 'bun:test'
import type { RuntimeExecutionGraph } from './protocol/types.js'
import {
  buildBackgroundContinuationPrompt,
  hasActiveBackgroundExecutionNodes,
  isMainThreadTaskNotification,
} from './backgroundTurnContinuation.js'

describe('Desktop 后台子智能体续轮', () => {
  test('Given 执行图仍有 queued 或 running 节点 When 判断 Turn 边界 Then 继续保持 Worker busy', () => {
    const graph = (status: 'queued' | 'running' | 'completed'): RuntimeExecutionGraph => ({
      runtimeSessionId: 'runtime',
      nodes: [{
        id: status,
        kind: 'subagent',
        description: status,
        status,
        transcriptAvailable: true,
      }],
      todos: [],
      updatedAt: 1,
    })

    expect(hasActiveBackgroundExecutionNodes(graph('queued'))).toBe(true)
    expect(hasActiveBackgroundExecutionNodes(graph('running'))).toBe(true)
    expect(hasActiveBackgroundExecutionNodes(graph('completed'))).toBe(false)
  })

  test('Given 主线程收到多个 task-notification When 构造隐藏续轮 Then 通知全部交给模型且不消费子线程消息', () => {
    const mainA = { value: '<task-notification>A</task-notification>', mode: 'task-notification' as const }
    const child = { value: '<task-notification>child</task-notification>', mode: 'task-notification' as const, agentId: 'child' as never }
    const mainB = { value: '<task-notification>B</task-notification>', mode: 'task-notification' as const }

    expect(isMainThreadTaskNotification(mainA)).toBe(true)
    expect(isMainThreadTaskNotification(child)).toBe(false)
    const prompt = buildBackgroundContinuationPrompt([mainA, child, mainB])
    expect(prompt).toContain('<task-notification>A</task-notification>')
    expect(prompt).toContain('<task-notification>B</task-notification>')
    expect(prompt).not.toContain('child')
    expect(prompt).toContain('继续完成当前任务')
  })
})
