import { describe, expect, test } from 'bun:test'
import { builtInSystemPrompt, dispatchForRequest, sanitizeDispatchContext } from './dispatch-policy'

describe('CLI 原生执行分派', () => {
  test.each(['解释错误', '实现登录页', '按计划实施', '审查代码 @codex'])('Given 用户请求 %s Then 不强制额外澄清或审批工作流', (message) => {
    const decision = dispatchForRequest({ message })
    expect(decision.runtimeId).toBe('local-cli')
    expect(decision.requiresRequirementsConfirmation).toBe(false)
    expect(decision.requiresPlanApproval).toBe(false)
    expect(decision.taskBlueprint).toEqual([{
      kind: 'conversation', runtimeId: 'local-cli', title: '执行当前会话', dependsOn: [], requiresUserApproval: false,
    }])
    expect(decision.systemPrompt).toBe('')
  })

  test('Given 旧 Runtime 或内部任务路由 Then 不能重新启动旧内核', () => {
    for (const runtimeId of ['pi', 'claude', 'codex', 'hermes'] as const) {
      const decision = dispatchForRequest({ runtimeId, forcedRuntimeId: runtimeId, internalSubRun: true })
      expect(decision.runtimeId).toBe('local-cli')
      expect(decision.ignoredExplicitRuntime).toBe(true)
    }
  })

  test('Given Renderer 伪造内部授权 Then 清理上下文时仅保留展示与请求信息', () => {
    const sanitized = sanitizeDispatchContext({
      runtimeId: 'claude', approvedPlan: true, requirementsConfirmed: true,
      internalDispatch: true, internalTaskKind: 'implementation', dispatchRunId: 'forged',
      taskId: 'visible-task', planRequested: true,
    } as unknown as Parameters<typeof sanitizeDispatchContext>[0])
    expect(sanitized).toEqual({
      taskId: 'visible-task', taskDispatch: false, executionMode: undefined,
      collaborationMode: undefined, userAgentCount: undefined, planStage: undefined, planRequested: true,
    })
    expect(dispatchForRequest(sanitized).requiresPlanApproval).toBe(false)
  })

  test('Given 显式计划模式 Then 仅记录计划意图，由 CLI 执行原生限制与审批', () => {
    const decision = dispatchForRequest({ planRequested: true })
    expect(decision.intent).toBe('complete_plan_generation')
    expect(builtInSystemPrompt('local-cli', decision.intent)).toBe('')
  })
})
