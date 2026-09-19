import { describe, expect, test } from 'bun:test'
import {
  getActiveAgentInteractionRequest,
} from './agent-interaction-panel'

describe('Agent 阻塞交互面板', () => {
  test('Given 三类请求交错到达 When 选择当前交互 Then 按主进程序号取最早请求', () => {
    expect(getActiveAgentInteractionRequest({
      permission: [{ requestId: 'permission-later', sequence: 7, createdAt: 100 }],
      askUser: [{ requestId: 'question-first', sequence: 5, createdAt: 120 }],
      exitPlan: [{ requestId: 'plan-middle', sequence: 6, createdAt: 90 }],
    })).toEqual({ kind: 'askUser', requestId: 'question-first' })
  })

  test('Given 旧请求没有序号 When 选择当前交互 Then 按时间并稳定回退原队列顺序', () => {
    expect(getActiveAgentInteractionRequest({
      permission: [{ requestId: 'permission', createdAt: 20 }],
      askUser: [{ requestId: 'question', createdAt: 10 }],
      exitPlan: [],
    })).toEqual({ kind: 'askUser', requestId: 'question' })

    expect(getActiveAgentInteractionRequest({
      permission: [{ requestId: 'permission' }],
      askUser: [{ requestId: 'question' }],
      exitPlan: [{ requestId: 'plan' }],
    })).toEqual({ kind: 'permission', requestId: 'permission' })
  })

  test('Given 新旧请求混合且旧请求时间更早 When 选择当前交互 Then 兼容 createdAt 的真实先后', () => {
    expect(getActiveAgentInteractionRequest({
      permission: [{ requestId: 'new', sequence: 8, createdAt: 20 }],
      askUser: [{ requestId: 'legacy', createdAt: 10 }],
      exitPlan: [],
    })).toEqual({ kind: 'askUser', requestId: 'legacy' })
  })

  test('Given 没有请求 When 选择当前交互 Then 返回空', () => {
    expect(getActiveAgentInteractionRequest({
      permission: [],
      askUser: [],
      exitPlan: [],
    })).toBeNull()
  })
})
