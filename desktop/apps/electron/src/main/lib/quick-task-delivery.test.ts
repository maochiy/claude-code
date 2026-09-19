import { describe, expect, test } from 'bun:test'
import { QuickTaskDeliveryCoordinator } from './quick-task-delivery'

describe('快速任务两阶段提交', () => {
  test('Given 主窗口准备完成 When 领取提交许可 Then 只在许可有效时确认提交', async () => {
    const coordinator = new QuickTaskDeliveryCoordinator(100)
    const { delivery, acknowledgement } = coordinator.create({
      submissionId: 'submission-1', mode: 'agent', text: '修复问题',
    })

    expect(delivery).toBeDefined()
    expect(coordinator.claim({
      requestId: delivery!.requestId,
      submissionId: 'submission-1',
      prepared: true,
    })).toEqual({ commit: true })
    await expect(acknowledgement).resolves.toBeUndefined()
  })

  test('Given 附件准备失败 When 主窗口报告失败 Then Quick Task 收到原始原因', async () => {
    const coordinator = new QuickTaskDeliveryCoordinator(100)
    const { delivery, acknowledgement } = coordinator.create({
      submissionId: 'submission-2', mode: 'chat', text: '分析文件',
    })

    expect(coordinator.claim({
      requestId: delivery!.requestId,
      submissionId: 'submission-2',
      prepared: false,
      error: '附件保存失败',
    })).toEqual({ commit: false, error: '附件保存失败' })
    await expect(acknowledgement).rejects.toThrow('附件保存失败')
  })

  test('Given 附件准备超过超时 When 迟到领取许可 Then 不允许自动发送', async () => {
    const coordinator = new QuickTaskDeliveryCoordinator(5)
    const { delivery, acknowledgement } = coordinator.create({
      submissionId: 'submission-slow', mode: 'agent', text: '慢附件',
    })

    await Bun.sleep(10)
    await expect(acknowledgement).rejects.toThrow('主窗口准备快速任务超时')
    expect(coordinator.claim({
      requestId: delivery!.requestId,
      submissionId: 'submission-slow',
      prepared: true,
    })).toEqual({ commit: false, error: '快速任务提交许可已过期' })
  })

  test('Given 同一 submissionId 超时后重试 When 旧请求迟到且新请求完成 Then 仅新请求提交一次', async () => {
    const coordinator = new QuickTaskDeliveryCoordinator(5)
    const first = coordinator.create({
      submissionId: 'submission-retry', mode: 'agent', text: '只执行一次',
    })
    await expect(first.acknowledgement).rejects.toThrow('主窗口准备快速任务超时')

    const second = coordinator.create({
      submissionId: 'submission-retry', mode: 'agent', text: '只执行一次',
    })
    const decisions = [
      coordinator.claim({
        requestId: first.delivery!.requestId,
        submissionId: 'submission-retry',
        prepared: true,
      }),
      coordinator.claim({
        requestId: second.delivery!.requestId,
        submissionId: 'submission-retry',
        prepared: true,
      }),
    ]

    expect(decisions.filter(decision => decision.commit)).toHaveLength(1)
    await expect(second.acknowledgement).resolves.toBeUndefined()

    const duplicate = coordinator.create({
      submissionId: 'submission-retry', mode: 'agent', text: '只执行一次',
    })
    expect(duplicate.delivery).toBeUndefined()
    await expect(duplicate.acknowledgement).resolves.toBeUndefined()
  })

  test('Given Main 已授予提交许可 When Renderer 随后退出 Then 不把已接收任务降级为可重试失败', async () => {
    const coordinator = new QuickTaskDeliveryCoordinator(100)
    const { delivery, acknowledgement } = coordinator.create({
      submissionId: 'submission-committed', mode: 'agent', text: '已接收任务',
    })
    expect(coordinator.claim({
      requestId: delivery!.requestId,
      submissionId: 'submission-committed',
      prepared: true,
    }).commit).toBe(true)

    expect(coordinator.fail(delivery!.requestId, new Error('Renderer 已退出'))).toBe(false)
    await expect(acknowledgement).resolves.toBeUndefined()
  })
})
