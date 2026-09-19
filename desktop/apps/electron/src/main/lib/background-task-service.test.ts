import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKMessage } from '@proma/shared'
import { BackgroundTaskService } from './background-task-service'

function sdkPayload(message: SDKMessage): AgentStreamPayload {
  return { kind: 'sdk_message', message }
}

function systemMessage(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'system',
    session_id: 'session-1',
    uuid: String(fields.uuid ?? crypto.randomUUID()),
    ...fields,
  } as SDKMessage
}

function createService(history: SDKMessage[] = []): {
  service: BackgroundTaskService
  persisted: SDKMessage[]
} {
  const persisted = [...history]
  return {
    persisted,
    service: new BackgroundTaskService({
      appendMessages: (_sessionId, messages) => { persisted.push(...messages) },
      loadMessages: () => persisted,
      now: () => 1_000,
    }),
  }
}

describe('后台任务主进程生命周期', () => {
  test('Given 运行任务未上报文件路径 When 打开日志 Then 按注册任务 ID 读取实时输出', async () => {
    const { service } = createService()
    const reads: string[][] = []
    service.setRuntimeControl({
      canStopTask: () => true,
      stopTask: async () => {},
      readTaskOutput: async (sessionId, taskId) => { reads.push([sessionId, taskId]); return '实时日志\n' },
    })
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_started', task_id: 'running', description: '运行中',
    })))
    expect(await service.getTaskOutput({ sessionId: 'session-1', taskId: 'running' }))
      .toMatchObject({ output: '实时日志\n', isComplete: false, isOutputAvailable: true })
    expect(reads).toEqual([['session-1', 'running']])
  })
  test('Given Runtime 依次发送开始进度和完成事件 When 查询快照 Then 保留真实输出与终态并落盘系统消息', () => {
    const { service, persisted } = createService()
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      description: '检查项目',
      task_type: 'agent',
      _createdAt: 100,
    })))
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_progress',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      description: '运行测试',
      summary: '已完成一半',
      usage: { duration_ms: 2_500 },
      _createdAt: 200,
    })))
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      status: 'completed',
      summary: '测试通过',
      output_file: '/tmp/runtime-owned-output',
      usage: { duration_ms: 3_000 },
      _createdAt: 300,
    })))

    expect(service.listTasks('session-1')).toEqual([
      expect.objectContaining({
        id: 'task-1',
        status: 'completed',
        output: '测试通过',
        outputFile: '/tmp/runtime-owned-output',
        elapsedSeconds: 3,
        canStop: false,
      }),
    ])
    expect(persisted).toHaveLength(3)
  })

  test('Given Runtime 支持单任务停止 When 用户点击停止 Then 只发送真实控制请求且等待通知确认终态', async () => {
    const { service } = createService()
    const stopped: string[] = []
    service.setRuntimeControl({
      canStopTask: () => true,
      stopTask: async (_sessionId, taskId) => { stopped.push(taskId) },
    })
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_started', task_id: 'task-1', description: '等待',
    })))

    await service.stopTask({ sessionId: 'session-1', taskId: 'task-1', type: 'agent' })

    expect(stopped).toEqual(['task-1'])
    expect(service.listTasks('session-1')[0]?.status).toBe('running')
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_notification', task_id: 'task-1', status: 'stopped', summary: '用户停止',
    })))
    expect(service.listTasks('session-1')[0]?.status).toBe('stopped')
  })

  test('Given 当前 Runtime 没有单任务控制 When 请求停止 Then 明确拒绝且不终止整个会话', async () => {
    const { service } = createService()
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_started', task_id: 'task-1', description: '等待',
    })))

    await expect(service.stopTask({
      sessionId: 'session-1', taskId: 'task-1', type: 'agent',
    })).rejects.toThrow('不支持单独停止')
    expect(service.listTasks('session-1')[0]?.status).toBe('running')
  })

  test('Given 进程重载后只有持久化历史 When 恢复快照 Then 仅恢复有明确终态的任务', () => {
    const history = [
      systemMessage({ subtype: 'task_started', task_id: 'running-only', description: '未知结局', _createdAt: 100 }),
      systemMessage({ subtype: 'task_started', task_id: 'finished', description: '已完成任务', _createdAt: 200 }),
      systemMessage({
        subtype: 'task_notification', task_id: 'finished', status: 'completed', summary: '完成', _createdAt: 300,
      }),
    ]
    const { service } = createService(history)

    expect(service.listTasks('session-1').map((task) => task.id)).toEqual(['finished'])
  })

  test('Given 运行与结束任务并存 When 清理 Finished Then 仅保留运行任务', () => {
    const { service } = createService()
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_started', task_id: 'running', description: '运行中',
    })))
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_notification', task_id: 'finished', status: 'failed', summary: '失败',
    })))

    service.clearFinished('session-1')

    expect(service.listTasks('session-1').map((task) => task.id)).toEqual(['running'])
  })

  test('Given Runtime 上报摘要与 output_file 但没有安全读取协议 When 获取输出 Then 标明仅有摘要且不读任意文件', async () => {
    const { service } = createService()
    service.observeStreamPayload('session-1', sdkPayload(systemMessage({
      subtype: 'task_notification',
      task_id: 'finished',
      status: 'completed',
      summary: '仅有摘要',
      output_file: '/etc/passwd',
    })))

    expect(await service.getTaskOutput({
      sessionId: 'session-1', taskId: 'finished', block: false,
    })).toEqual({
      output: '仅有摘要',
      isComplete: true,
      isOutputAvailable: true,
      unavailableReason: 'runtime_output_read_unsupported',
    })
  })
})
