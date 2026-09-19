import { describe, expect, test } from 'bun:test'
import { parseReplayResetSnapshot } from './replay-recovery'

describe('replay_reset 权威快照', () => {
  test('只保留有效待处理交互和仍在运行的后台任务', () => {
    expect(parseReplayResetSnapshot({
      activeRunId: 'run-live',
      pendingControls: [
        {
          cliRequestId: 'permission-1',
          subtype: 'can_use_tool',
          request: { subtype: 'can_use_tool', tool_name: 'Write' },
          createdAt: 123,
        },
        { cliRequestId: '', subtype: 'can_use_tool', request: {} },
        { cliRequestId: 'broken', subtype: 'can_use_tool', request: 'invalid' },
      ],
      tasks: [
        { taskId: 'task-live', state: 'running', updatedAt: 1 },
        { taskId: 'task-done', state: 'completed', updatedAt: 2 },
        { taskId: '', state: 'running', updatedAt: 3 },
        { taskId: 'task-invalid', state: 'unknown', updatedAt: 4 },
      ],
    })).toEqual({
      activeRunId: 'run-live',
      pendingControls: [{
        cliRequestId: 'permission-1',
        subtype: 'can_use_tool',
        request: { subtype: 'can_use_tool', tool_name: 'Write' },
        createdAt: 123,
      }],
      runningTaskIds: ['task-live'],
    })
  })

  test('缺失或畸形字段按空快照处理', () => {
    expect(parseReplayResetSnapshot({
      activeRunId: null,
      pendingControls: 'invalid',
      tasks: null,
    })).toEqual({
      pendingControls: [],
      runningTaskIds: [],
    })
  })
})
