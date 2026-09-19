import { describe, expect, test } from 'bun:test'
import type { AgentInteractionSettlement, PermissionRequest } from '@proma/shared'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

function options(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID }
}

describe('AgentPermissionService 请求生命周期', () => {
  test('Given 写工具需要批准 When 创建并允许 Then 请求先入队且仅产生一次可持久化终态', async () => {
    const service = new AgentPermissionService()
    const abortController = new AbortController()
    const settlements: AgentInteractionSettlement[] = []
    let request: PermissionRequest | undefined
    const canUseTool = service.createCanUseTool(
      'session-permission',
      (nextRequest) => {
        request = nextRequest
        expect(service.getPendingRequests().map((item) => item.requestId)).toContain(nextRequest.requestId)
      },
      undefined,
      undefined,
      {
        requestContext: { runId: 'run-1' },
        onSettled: (settlement) => settlements.push(settlement),
      },
    )

    const result = canUseTool(
      'Write',
      { file_path: '/workspace/a.ts', content: 'value' },
      options(abortController.signal, 'tool-write'),
    )
    expect(request?.createdAt).toBeNumber()
    expect(request?.sequence).toBeNumber()
    expect(request?.toolUseId).toBe('tool-write')
    expect(request?.runId).toBe('run-1')
    expect(service.respondToPermission(request!.requestId, 'allow', false)).toBe('session-permission')

    await expect(result).resolves.toMatchObject({ behavior: 'allow' })
    expect(settlements).toEqual([expect.objectContaining({
      requestId: request!.requestId,
      kind: 'permission',
      outcome: 'allowed',
      behavior: 'allow',
      toolUseId: 'tool-write',
      runId: 'run-1',
    })])
    expect(service.respondToPermission(request!.requestId, 'deny', false)).toBeNull()
    expect(settlements).toHaveLength(1)
  })

  test('Given 权限请求正在等待 When 运行中止 Then 请求拒绝、移出队列且记录 aborted', async () => {
    const service = new AgentPermissionService()
    const abortController = new AbortController()
    const settlements: AgentInteractionSettlement[] = []
    const canUseTool = service.createCanUseTool(
      'session-abort',
      () => undefined,
      undefined,
      undefined,
      { onSettled: (settlement) => settlements.push(settlement) },
    )

    const result = canUseTool('Edit', { file_path: 'a.ts' }, options(abortController.signal, 'tool-edit'))
    abortController.abort()

    await expect(result).resolves.toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(service.getPendingRequests()).toHaveLength(0)
    expect(settlements.map((item) => item.outcome)).toEqual(['aborted'])
  })

  test('Given 多个同会话请求 When 同毫秒排队 Then sequence 保持创建顺序且清理产生 cancelled', async () => {
    const service = new AgentPermissionService()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const settlements: AgentInteractionSettlement[] = []
    const canUseTool = service.createCanUseTool(
      'session-order',
      () => undefined,
      undefined,
      undefined,
      { onSettled: (settlement) => settlements.push(settlement) },
    )

    const first = canUseTool('Write', { file_path: 'first.ts' }, options(firstAbort.signal, 'first'))
    const second = canUseTool('Write', { file_path: 'second.ts' }, options(secondAbort.signal, 'second'))
    const pending = service.getPendingRequests()
    expect(pending).toHaveLength(2)
    expect(pending[0]!.sequence!).toBeLessThan(pending[1]!.sequence!)

    service.clearSessionPending('session-order')
    await Promise.all([first, second])
    expect(settlements.map((item) => item.outcome)).toEqual(['cancelled', 'cancelled'])
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given Renderer 发送回调抛错 When 创建权限请求 Then 以 delivery_failed 结束而不泄漏', async () => {
    const service = new AgentPermissionService()
    const settlements: AgentInteractionSettlement[] = []
    const canUseTool = service.createCanUseTool(
      'session-delivery',
      () => { throw new Error('窗口已销毁') },
      undefined,
      undefined,
      { onSettled: (settlement) => settlements.push(settlement) },
    )

    await expect(canUseTool(
      'Write',
      { file_path: 'a.ts' },
      options(new AbortController().signal, 'tool-delivery'),
    )).resolves.toEqual({ behavior: 'deny', message: '无法发起权限确认' })
    expect(settlements.map((item) => item.outcome)).toEqual(['delivery_failed'])
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 权限请求待处理 When 收到畸形或迟到响应 Then 不误结算且只允许一次有效终态', async () => {
    const service = new AgentPermissionService()
    const settlements: AgentInteractionSettlement[] = []
    let requestId = ''
    const result = service.createCanUseTool(
      'session-validation',
      (request) => { requestId = request.requestId },
      undefined,
      undefined,
      { onSettled: (settlement) => settlements.push(settlement) },
    )('Write', { file_path: 'safe.ts' }, options(new AbortController().signal, 'tool-validation'))

    expect(() => service.respondToPermission(requestId, 'unexpected' as 'allow', false))
      .toThrow('权限响应行为无效')
    expect(service.getPendingRequests()).toHaveLength(1)
    expect(service.respondToPermission(requestId, 'allow', false)).toBe('session-validation')
    await expect(result).resolves.toMatchObject({ behavior: 'allow' })
    expect(service.respondToPermission(requestId, 'deny', false)).toBeNull()
    expect(settlements).toHaveLength(1)
  })
})
