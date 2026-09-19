import { describe, expect, test } from 'bun:test'
import type { AgentInteractionSettlement, ExitPlanModeRequest } from '@proma/shared'
import { AgentExitPlanService } from './agent-exit-plan-service'

describe('AgentExitPlanService 请求生命周期', () => {
  test('Given 计划审批请求 When 用户批准 Then 保留运行关联并结算为 approved', async () => {
    const service = new AgentExitPlanService()
    const settlements: AgentInteractionSettlement[] = []
    let request: ExitPlanModeRequest | undefined
    const result = service.handleExitPlanMode(
      'session-plan',
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
      new AbortController().signal,
      (nextRequest) => { request = nextRequest },
      {
        requestContext: { toolUseId: 'exit-tool', runId: 'run-plan' },
        onSettled: (settlement) => settlements.push(settlement),
      },
    )

    expect(request).toMatchObject({
      toolUseId: 'exit-tool',
      runId: 'run-plan',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    })
    expect(service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' }))
      .toEqual({ sessionId: 'session-plan', targetMode: 'bypassPermissions' })
    await expect(result).resolves.toMatchObject({ behavior: 'allow', targetMode: 'bypassPermissions' })
    expect(settlements).toEqual([expect.objectContaining({
      kind: 'exit_plan', outcome: 'approved', behavior: 'allow', toolUseId: 'exit-tool', runId: 'run-plan',
    })])
  })

  test('Given 计划审批正在等待 When AbortSignal 中止 Then 拒绝并清除请求', async () => {
    const service = new AgentExitPlanService()
    const abortController = new AbortController()
    const settlements: AgentInteractionSettlement[] = []
    const result = service.handleExitPlanMode(
      'session-abort', {}, abortController.signal, () => undefined,
      { onSettled: (settlement) => settlements.push(settlement) },
    )
    abortController.abort()

    await expect(result).resolves.toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(settlements.map((item) => item.outcome)).toEqual(['aborted'])
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 两个计划审批排队 When 清理会话 Then 按序产生 cancelled 且旧响应失效', async () => {
    const service = new AgentExitPlanService()
    const settlements: AgentInteractionSettlement[] = []
    let firstRequestId = ''
    const lifecycle = { onSettled: (settlement: AgentInteractionSettlement) => settlements.push(settlement) }
    const first = service.handleExitPlanMode(
      'session-order', {}, new AbortController().signal,
      (request) => { firstRequestId = request.requestId }, lifecycle,
    )
    const second = service.handleExitPlanMode(
      'session-order', {}, new AbortController().signal, () => undefined, lifecycle,
    )
    const pending = service.getPendingRequests()
    expect(pending[0]!.sequence!).toBeLessThan(pending[1]!.sequence!)

    service.clearSessionPending('session-order')
    await Promise.all([first, second])
    expect(settlements.map((item) => item.outcome)).toEqual(['cancelled', 'cancelled'])
    expect(service.respondToExitPlanMode({ requestId: firstRequestId, action: 'deny' })).toBeNull()
  })

  test('Given Renderer 无法接收计划请求 When 发送抛错 Then delivery_failed 且不残留 pending', async () => {
    const service = new AgentExitPlanService()
    const settlements: AgentInteractionSettlement[] = []
    const result = service.handleExitPlanMode(
      'session-delivery', {}, new AbortController().signal,
      () => { throw new Error('窗口已销毁') },
      { onSettled: (settlement) => settlements.push(settlement) },
    )

    await expect(result).resolves.toEqual({ behavior: 'deny', message: '无法发起计划确认' })
    expect(settlements.map((item) => item.outcome)).toEqual(['delivery_failed'])
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 计划待批准 When 选择审批模式 Then 返回确切目标模式并仅结算一次', async () => {
    const service = new AgentExitPlanService()
    const settlements: AgentInteractionSettlement[] = []
    let requestId = ''
    const result = service.handleExitPlanMode(
      'session-target-mode',
      { plan: '# Plan' },
      new AbortController().signal,
      (request) => { requestId = request.requestId },
      { onSettled: (settlement) => settlements.push(settlement) },
    )

    expect(service.respondToExitPlanMode({
      requestId,
      action: 'approve',
      approvalMode: 'acceptEdits',
    })).toEqual({ sessionId: 'session-target-mode', targetMode: 'acceptEdits' })
    await expect(result).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { plan: '# Plan' },
      targetMode: 'acceptEdits',
    })
    expect(service.respondToExitPlanMode({ requestId, action: 'deny' })).toBeNull()
    expect(settlements).toHaveLength(1)
  })

  test('Given 计划待批准 When 目标模式或反馈无效 Then 保留 pending 供用户重试', async () => {
    const service = new AgentExitPlanService()
    const abortController = new AbortController()
    let requestId = ''
    const result = service.handleExitPlanMode(
      'session-invalid-plan-response',
      {},
      abortController.signal,
      (request) => { requestId = request.requestId },
    )

    expect(() => service.respondToExitPlanMode({ requestId, action: 'approve' }))
      .toThrow('必须提供有效的目标审批模式')
    expect(() => service.respondToExitPlanMode({ requestId, action: 'feedback', feedback: '   ' }))
      .toThrow('计划修改意见不能为空')
    expect(service.getPendingRequests()).toHaveLength(1)

    expect(service.respondToExitPlanMode({ requestId, action: 'feedback', feedback: '  请补充验收步骤  ' }))
      .toEqual({ sessionId: 'session-invalid-plan-response', targetMode: null })
    await expect(result).resolves.toEqual({ behavior: 'deny', message: '请补充验收步骤' })
  })
})
