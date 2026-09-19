import { describe, expect, test } from 'bun:test'
import {
  areDynamicWorkflowsEnabled,
  constrainWorkflowConcurrency,
} from '../dynamicWorkflows.js'

describe('动态工作流会话策略', () => {
  test('纯 CLI 未提供桌面偏好时保留原有并行行为', () => {
    expect(areDynamicWorkflowsEnabled(undefined)).toBe(true)
    expect(constrainWorkflowConcurrency({ maxConcurrency: 6 }, true)).toEqual({
      maxConcurrency: 6,
    })
  })

  test('桌面关闭动态工作流时只把子 Agent 并发限制为一', () => {
    expect(areDynamicWorkflowsEnabled('0')).toBe(false)
    expect(areDynamicWorkflowsEnabled('false')).toBe(false)
    expect(constrainWorkflowConcurrency({ maxConcurrency: 9 }, false)).toEqual({
      maxConcurrency: 1,
    })
    const singleAgentInput: { name: string; maxConcurrency?: number } = {
      name: 'single-agent',
    }
    expect(constrainWorkflowConcurrency(singleAgentInput, false)).toEqual({
      name: 'single-agent',
      maxConcurrency: 1,
    })
  })

  test('桌面开启动态工作流时允许现有并行策略', () => {
    expect(areDynamicWorkflowsEnabled('1')).toBe(true)
    expect(areDynamicWorkflowsEnabled('true')).toBe(true)
  })
})
