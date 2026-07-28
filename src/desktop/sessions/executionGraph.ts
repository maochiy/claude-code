import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { TaskState } from '../../tasks/types.js'
import { toSDKMessages } from '../../utils/messages/mappers.js'
import { getTaskListId, listTasks } from '../../utils/tasks.js'
import type {
  RuntimeExecutionGraph,
  RuntimeExecutionNode,
  RuntimeExecutionNodeKind,
  RuntimeExecutionNodeStatus,
  RuntimeSubagentTranscript,
  RuntimeTodoItem,
} from '../protocol/types.js'

function toNodeKind(task: TaskState): RuntimeExecutionNodeKind {
  switch (task.type) {
    case 'local_agent':
      return 'subagent'
    case 'in_process_teammate':
      return 'teammate'
    case 'local_workflow':
      return 'workflow-agent'
    case 'local_bash':
    case 'monitor_mcp':
      return 'shell'
    default:
      return 'background-task'
  }
}

function toNodeStatus(status: TaskState['status']): RuntimeExecutionNodeStatus {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'killed':
      return 'stopped'
    default:
      return status
  }
}

function optionalString(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function taskMessages(task: TaskState): SDKMessage[] {
  if (!('messages' in task) || !Array.isArray(task.messages)) return []
  return toSDKMessages(task.messages)
}

function toExecutionNode(task: TaskState): RuntimeExecutionNode {
  const record = task as unknown as Record<string, unknown>
  const identity =
    record.identity && typeof record.identity === 'object'
      ? record.identity as Record<string, unknown>
      : undefined
  const selectedAgent =
    record.selectedAgent && typeof record.selectedAgent === 'object'
      ? record.selectedAgent as Record<string, unknown>
      : undefined
  const result =
    record.result && typeof record.result === 'object'
      ? record.result as Record<string, unknown>
      : undefined
  const progress =
    record.progress && typeof record.progress === 'object'
      ? record.progress as Record<string, unknown>
      : undefined
  return {
    id: task.id,
    kind: toNodeKind(task),
    status: toNodeStatus(task.status),
    description: task.description,
    startedAt: task.startTime,
    completedAt: task.endTime,
    toolUseId: task.toolUseId,
    transcriptAvailable: taskMessages(task).length > 0,
    name:
      optionalString(identity?.agentName)
      ?? optionalString(selectedAgent?.name)
      ?? optionalString(record.agentType),
    summary:
      optionalString(progress?.summary)
      ?? optionalString(result?.content)
      ?? optionalString(record.error),
    model: optionalString(record.model),
    agentType: optionalString(record.agentType),
    teamName: optionalString(identity?.teamName),
    parentId: optionalString(record.parentTaskId),
  }
}

async function resolveTodos(appState: AppState): Promise<RuntimeTodoItem[]> {
  const taskList = await listTasks(getTaskListId()).catch(() => [])
  if (taskList.length > 0) {
    return taskList.map(task => ({
      id: task.id,
      content: task.subject,
      status: task.status,
      activeForm: task.activeForm,
      owner: task.owner,
      blocks: [...task.blocks],
      blockedBy: [...task.blockedBy],
    }))
  }

  const legacyTodos = Object.values(appState.todos).flat()
  return legacyTodos.map((todo, index) => ({
    id: `todo-${index}`,
    content: todo.content,
    status: todo.status,
    activeForm: todo.activeForm,
  }))
}

export async function buildRuntimeExecutionGraph(
  runtimeSessionId: string,
  appState: AppState,
): Promise<RuntimeExecutionGraph> {
  return {
    runtimeSessionId,
    nodes: Object.values(appState.tasks).map(toExecutionNode),
    todos: await resolveTodos(appState),
    updatedAt: Date.now(),
  }
}

export function resolveRuntimeSubagentTranscript(
  appState: AppState,
  executionNodeId: string,
): RuntimeSubagentTranscript {
  const task = appState.tasks[executionNodeId]
  if (!task) {
    throw new Error(`执行节点不存在: ${executionNodeId}`)
  }
  return {
    executionNodeId,
    messages: taskMessages(task),
  }
}
