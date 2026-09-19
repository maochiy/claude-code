import { describe, expect, test } from 'bun:test'
import type { BackgroundTask } from '@/atoms/agent-atoms'
import {
  applyBackgroundTaskOutputResponse,
  groupBackgroundTasks,
  mergeBackgroundTaskHistory,
  projectPersistedBackgroundTasks,
  reconcileBackgroundTaskSnapshot,
  selectTurnBackgroundTasks,
  summarizeBackgroundTasks,
  toBackgroundTaskOutput,
} from './background-task-presentation'

function task(
  toolUseId: string,
  status: BackgroundTask['status'],
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask {
  return {
    id: `task-${toolUseId}`,
    type: 'agent',
    toolUseId,
    startTime: 100,
    elapsedSeconds: 1,
    status,
    ...overrides,
  }
}

describe('后台任务展示数据', () => {
  test('Given 当前会话有运行与终态任务 When 分组 Then 结束任务保留且按最新结束时间排列', () => {
    const tasks = [
      task('running', 'running'),
      task('old', 'completed', { completedAt: 200 }),
      task('new', 'stopped', { completedAt: 300 }),
    ]

    const groups = groupBackgroundTasks(tasks)

    expect(groups.running.map((item) => item.toolUseId)).toEqual(['running'])
    expect(groups.finished.map((item) => item.toolUseId)).toEqual(['new', 'old'])
  })

  test('Given 多轮后台任务 When 渲染一轮摘要 Then 仅选择该轮 toolUseId 与 turnId 对应项', () => {
    const tasks = [
      task('tool-a', 'completed', { turnId: 'turn-a' }),
      task('tool-b', 'completed', { turnId: 'turn-b' }),
      task('legacy-tool', 'stopped'),
    ]

    expect(selectTurnBackgroundTasks({
      tasks,
      turnId: 'turn-a',
      toolUseIds: ['legacy-tool'],
    }).map((item) => item.toolUseId)).toEqual(['tool-a', 'legacy-tool'])
  })

  test('Given 一轮任务状态混合 When 生成摘要 Then 不把总数错误描述成全部失败', () => {
    const summary = summarizeBackgroundTasks([
      task('done', 'completed'),
      task('failed', 'failed'),
      task('stopped', 'stopped'),
    ])

    expect(summary).toEqual({ count: 3, status: 'mixed' })
    expect(summarizeBackgroundTasks([
      task('stopped-1', 'stopped'),
      task('stopped-2', 'stopped'),
    ])).toEqual({ count: 2, status: 'stopped' })
  })

  test('Given SDK 未提供可用输出 When 格式化 Then 不虚构任务输出', () => {
    expect(toBackgroundTaskOutput('  real output  ')).toBe('real output')
    expect(toBackgroundTaskOutput({ result: 'ok' })).toBe('{\n  "result": "ok"\n}')
    expect(toBackgroundTaskOutput({})).toBeUndefined()
    expect(toBackgroundTaskOutput(undefined)).toBeUndefined()
  })

  test('Given 历史 SDK 消息含明确任务终态 When 恢复会话 Then 保留真实描述摘要与命令', () => {
    const projected = projectPersistedBackgroundTasks([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-1',
        tool_use_id: 'tool-agent-1',
        description: '检查项目',
        task_type: 'agent',
        _createdAt: 100,
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-1',
        status: 'completed',
        summary: '检查完成',
        output_file: '/tmp/task-output.txt',
        usage: { duration_ms: 2500 },
        _createdAt: 200,
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        background_tasks: [{
          id: 'shell-1',
          type: 'bash',
          status: 'failed',
          description: '执行构建',
          command: 'bun run build',
        }],
        _createdAt: 300,
      },
    ])

    expect(projected).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        toolUseId: 'tool-agent-1',
        status: 'completed',
        intent: '检查项目',
        output: '检查完成',
        elapsedSeconds: 2.5,
      }),
      expect.objectContaining({
        id: 'shell-1',
        type: 'shell',
        status: 'failed',
        intent: '执行构建',
        command: 'bun run build',
      }),
    ])
  })

  test('Given 历史只有 started 或未知状态 When 恢复会话 Then 不猜测任务仍在运行', () => {
    expect(projectPersistedBackgroundTasks([
      { type: 'system', subtype: 'task_started', task_id: 'unknown', description: '未结束' },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        background_tasks: [{ id: 'running', type: 'agent', status: 'running', description: '仍在运行' }],
      },
    ])).toEqual([])
  })

  test('Given 历史终态与同任务实时进度并存 When 合并 Then 实时状态优先且保留历史摘要', () => {
    const historical = task('same-tool', 'completed', {
      id: 'same-task',
      output: '历史摘要',
      intent: '历史标题',
    })
    const live = task('same-tool', 'running', {
      id: 'same-task',
      intent: '实时标题',
    })

    expect(mergeBackgroundTaskHistory([historical], [live])).toEqual([
      expect.objectContaining({
        id: 'same-task',
        status: 'running',
        intent: '实时标题',
        output: '历史摘要',
      }),
    ])
  })

  test('Given 快照请求期间实时任务进入终态 When 快照返回旧运行态 Then 不覆盖实时终态', () => {
    const before = task('same', 'running', { id: 'same-task' })
    const completed = { ...before, status: 'completed' as const, output: '真实完成', completedAt: 300 }

    expect(reconcileBackgroundTaskSnapshot({
      baseline: [before],
      current: [completed],
      snapshots: [{
        ...before,
        updatedAt: 200,
        canStop: true,
      }],
    })).toEqual([
      expect.objectContaining({ status: 'completed', output: '真实完成', completedAt: 300 }),
    ])
  })

  test('Given 快照请求期间用户清理 Finished When 快照返回旧记录 Then 不重新插回已清理任务', () => {
    const finished = task('finished', 'completed')

    expect(reconcileBackgroundTaskSnapshot({
      baseline: [finished],
      current: [],
      snapshots: [{ ...finished, updatedAt: 200, canStop: false }],
    })).toEqual([])
  })

  test('Given 输出请求期间实时事件写入新输出 When 慢响应返回旧输出 Then 保留实时新输出', () => {
    const baseline = task('output', 'running', { output: '旧摘要' })
    const current = { ...baseline, output: '实时完整输出' }

    expect(applyBackgroundTaskOutputResponse({
      baseline,
      current,
      output: '过期响应',
    })).toBe(current)
  })
})
