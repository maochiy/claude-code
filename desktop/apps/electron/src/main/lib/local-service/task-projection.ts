import type { AgentRuntimeExecutionGraph, AgentRuntimeExecutionNode, AgentRuntimeTodoItem, AgentRuntimeSubagentTranscript, SDKMessage } from '@proma/shared'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function projectLocalCliTodos(value: unknown): AgentRuntimeTodoItem[] {
  if (!Array.isArray(value)) throw new Error('CLI 返回了无效的计划任务快照')
  return value.map(item => {
    const task = object(item)
    if (typeof task.id !== 'string' || typeof task.status !== 'string') throw new Error('CLI 计划任务缺少 ID 或状态')
    return { id: task.id, content: String(task.subject || task.description || ''), status: task.status,
      ...(typeof task.activeForm === 'string' ? { activeForm: task.activeForm } : {}),
      ...(typeof task.owner === 'string' ? { owner: task.owner } : {}),
      blocks: Array.isArray(task.blocks) ? task.blocks.filter((id): id is string => typeof id === 'string') : [],
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter((id): id is string => typeof id === 'string') : [],
    }
  })
}

export function projectLocalCliTasks(value: Record<string, unknown>, runtimeSessionId?: string,
  todos: AgentRuntimeTodoItem[] = []): AgentRuntimeExecutionGraph {
  if (!Array.isArray(value.tasks) || typeof value.captured_at !== 'number') throw new Error('CLI 返回了无效的执行任务快照')
  const nodes: AgentRuntimeExecutionNode[] = value.tasks.map(item => {
    const task = object(item)
    if (typeof task.task_id !== 'string' || typeof task.status !== 'string') throw new Error('CLI 执行任务缺少 ID 或状态')
    const status = task.status === 'killed' ? 'stopped' : task.status === 'pending' ? 'queued' : task.status
    if (!['queued', 'running', 'completed', 'failed', 'stopped'].includes(status)) throw new Error(`CLI 任务状态不可识别：${status}`)
    return {
      id: task.task_id,
      kind: task.task_type === 'local_agent' ? 'subagent' : task.task_type === 'in_process_teammate' ? 'teammate'
        : task.task_type === 'local_bash' ? 'shell' : 'background-task',
      status: status as AgentRuntimeExecutionNode['status'],
      description: typeof task.description === 'string' ? task.description : task.task_id,
      transcriptAvailable: task.transcript_available === true,
      ...(typeof task.parent_task_id === 'string' ? { parentId: task.parent_task_id } : {}),
      ...(typeof task.tool_use_id === 'string' ? { toolUseId: task.tool_use_id } : {}),
      ...(typeof task.start_time === 'number' ? { startedAt: task.start_time } : {}),
      ...(typeof task.end_time === 'number' ? { completedAt: task.end_time } : {}),
      ...(typeof task.model === 'string' ? { model: task.model } : {}),
      ...(typeof task.agent_type === 'string' ? { agentType: task.agent_type } : {}),
    }
  })
  return { runtimeSessionId, nodes, todos, updatedAt: value.captured_at }
}

export function projectLocalCliTaskTranscript(taskId: string, value: Record<string, unknown>): AgentRuntimeSubagentTranscript {
  if (value.task_id !== taskId || !Array.isArray(value.messages)
    || !value.messages.every(message => typeof object(message).type === 'string')) {
    throw new Error('CLI 子代理记录与请求任务不匹配')
  }
  return { executionNodeId: taskId, messages: value.messages as SDKMessage[] }
}
