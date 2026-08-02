import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import {
  buildRuntimeExecutionGraph,
  resolveRuntimeSubagentTranscript,
} from './executionGraph.js'

function appStateWithTasks(): AppState {
  const userMessage = {
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000010',
    timestamp: '2026-07-28T00:00:00.000Z',
    message: {
      role: 'user',
      content: '检查项目',
    },
  } as Message

  return {
    tasks: {
      'agent-1': {
        id: 'agent-1',
        type: 'local_agent',
        status: 'running',
        description: '扫描代码',
        prompt: '检查项目',
        startTime: 10,
        toolUseId: 'tool-agent-1',
        agentType: 'Explore',
        model: 'claude-sonnet-4-6',
        messages: [userMessage],
      },
      'teammate-1': {
        id: 'teammate-1',
        type: 'in_process_teammate',
        status: 'completed',
        description: '审查变更',
        prompt: '请审查当前变更',
        startTime: 20,
        endTime: 30,
        toolUseId: 'tool-teammate-1',
        identity: {
          agentId: 'reviewer@desktop-team',
          agentName: 'Reviewer',
          teamName: 'desktop-team',
        },
        messages: [],
      },
    },
    todos: {
      default: [
        {
          content: '完成桌面接入',
          status: 'in_progress',
          activeForm: '正在完成桌面接入',
        },
      ],
    },
  } as unknown as AppState
}

describe('Desktop Runtime CCB 执行图', () => {
  test('Given CCB AppState When 构建执行图 Then 映射 Subagent、Teammate 与 Todo', async () => {
    const graph = await buildRuntimeExecutionGraph(
      'ccb-session-1',
      appStateWithTasks(),
    )

    expect(graph.runtimeSessionId).toBe('ccb-session-1')
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        status: 'running',
        agentType: 'Explore',
        transcriptAvailable: true,
      }),
    )
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: 'teammate-1',
        kind: 'teammate',
        status: 'completed',
        name: 'Reviewer',
        teamName: 'desktop-team',
        transcriptAvailable: true,
      }),
    )
    expect(graph.todos).toContainEqual(
      expect.objectContaining({
        content: '完成桌面接入',
        status: 'in_progress',
      }),
    )
  })

  test('Given CCB 运行中内存消息缺少首条提示词 When 读取 Transcript Then 自动补齐发送提示词', async () => {
    const state = appStateWithTasks()
    const task = state.tasks['agent-1']
    if (!task || task.type !== 'local_agent') {
      throw new Error('测试数据缺少 local_agent')
    }
    task.messages = [{
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000011',
      timestamp: '2026-07-28T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '正在检查' }],
      },
    } as Message]

    const transcript = await resolveRuntimeSubagentTranscript(
      state,
      'agent-1',
    )

    expect(transcript.messages[0]).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: '检查项目',
      },
    })
    expect(transcript.messages[1]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '正在检查' }],
      },
    })
  })

  test('Given CCB Teammate 已保存包装后的首条提示词 When 读取 Transcript Then 不重复补齐纯文本提示词', async () => {
    const state = appStateWithTasks()
    const task = state.tasks['teammate-1']
    if (!task || task.type !== 'in_process_teammate') {
      throw new Error('测试数据缺少 in_process_teammate')
    }
    task.messages = [{
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000012',
      timestamp: '2026-07-28T00:00:00.000Z',
      message: {
        role: 'user',
        content: '<teammate-message teammate_id="team-lead" summary="审查变更">\n请审查当前变更\n</teammate-message>',
      },
    } as Message]

    const transcript = await resolveRuntimeSubagentTranscript(
      state,
      'teammate-1',
    )

    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]).toMatchObject({
      type: 'user',
      message: {
        content: expect.stringContaining('请审查当前变更'),
      },
    })
  })

  test('Given CCB 子代理消息 When 读取 Transcript Then 使用 SDKMessage wire shape', async () => {
    const transcript = await resolveRuntimeSubagentTranscript(
      appStateWithTasks(),
      'agent-1',
    )

    expect(transcript.executionNodeId).toBe('agent-1')
    expect(transcript.messages[0]).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: '检查项目',
      },
    })
  })
})
