import { describe, expect, test } from 'bun:test'
import { projectLocalCliTasks, projectLocalCliTodos, projectLocalCliTaskTranscript } from './task-projection'

describe('原生任务投影', () => {
  test('父子任务和单任务停止保持独立，计划条目保留依赖', () => {
    const todos = projectLocalCliTodos([{ id: '1', subject: '检查', status: 'in_progress', blocks: ['2'] }])
    const graph = projectLocalCliTasks({ captured_at: 123, tasks: [
      { task_id: 'parent', task_type: 'local_agent', status: 'running', description: '分析', transcript_available: true },
      { task_id: 'child', parent_task_id: 'parent', task_type: 'local_bash', status: 'killed', tool_use_id: 'tool-1' },
    ] }, 'native', todos)
    expect(graph.nodes[0]).toMatchObject({ kind: 'subagent', status: 'running', transcriptAvailable: true })
    expect(graph.nodes[1]).toMatchObject({ parentId: 'parent', kind: 'shell', status: 'stopped', toolUseId: 'tool-1' })
    expect(graph.todos[0]).toMatchObject({ id: '1', content: '检查', blocks: ['2'] })
    expect(graph.updatedAt).toBe(123)
  })
  test('不完整快照或未知状态不能伪装为空任务列表', () => {
    expect(() => projectLocalCliTasks({})).toThrow('无效')
    expect(() => projectLocalCliTasks({ captured_at: 1, tasks: [{ task_id: 'a', status: 'unknown' }] })).toThrow('不可识别')
  })
  test('子代理记录必须匹配当前请求，保留原生消息与工具内容', () => {
    const messages = [{ type: 'assistant', uuid: 'm', message: { content: [{ type: 'text', text: '结果' }] } }]
    expect(projectLocalCliTaskTranscript('task', { task_id: 'task', messages }).messages).toEqual(messages)
    expect(() => projectLocalCliTaskTranscript('other', { task_id: 'task', messages })).toThrow('不匹配')
  })
})
