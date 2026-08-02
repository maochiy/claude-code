import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { TaskState } from '../../tasks/types.js'
import { asAgentId } from '../../types/ids.js'
import { toSDKMessages } from '../../utils/messages/mappers.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'
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

function taskMessagesInMemory(task: TaskState): SDKMessage[] {
  if (!('messages' in task) || !Array.isArray(task.messages)) return []
  return toSDKMessages(task.messages)
}

function taskTranscriptAgentId(task: TaskState): string | undefined {
  if (task.type === 'local_agent') return task.agentId
  if (task.type === 'in_process_teammate') return task.identity.agentId
  return undefined
}

function sdkMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as unknown as Record<string, unknown>).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined
}

function sdkUserText(message: SDKMessage): string | undefined {
  if (message.type !== 'user') return undefined
  const record = message as unknown as Record<string, unknown>
  const inner = record.message
  if (!inner || typeof inner !== 'object') return undefined
  const content = (inner as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined

  const text = content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const blockRecord = block as Record<string, unknown>
    return blockRecord.type === 'text' && typeof blockRecord.text === 'string'
      ? [blockRecord.text]
      : []
  }).join('\n')
  return text.length > 0 ? text : undefined
}

/**
 * 磁盘 Transcript 是完整历史，AppState messages 是运行中的最新镜像。
 * 以磁盘顺序为基线并用相同 UUID 的内存消息覆盖，避免 UI 在运行期间只看到
 * 被截断的内存尾部，也确保子智能体首条提示词不会短暂丢失。
 */
function mergeTaskMessages(
  persisted: SDKMessage[],
  inMemory: SDKMessage[],
): SDKMessage[] {
  const merged = [...persisted]
  const indexByUuid = new Map<string, number>()
  merged.forEach((message, index) => {
    const uuid = sdkMessageUuid(message)
    if (uuid) indexByUuid.set(uuid, index)
  })

  for (const message of inMemory) {
    const uuid = sdkMessageUuid(message)
    const existingIndex = uuid ? indexByUuid.get(uuid) : undefined
    if (existingIndex !== undefined) {
      merged[existingIndex] = message
      continue
    }
    if (uuid) indexByUuid.set(uuid, merged.length)
    merged.push(message)
  }
  return merged
}

function ensureTaskPrompt(
  task: TaskState,
  messages: SDKMessage[],
): SDKMessage[] {
  if (task.type !== 'local_agent' && task.type !== 'in_process_teammate') {
    return messages
  }
  const prompt = task.prompt.trim()
  if (prompt.length === 0) return messages
  const hasPrompt = messages.some(message => {
    const text = sdkUserText(message)?.trim()
    if (!text) return false
    if (text === prompt) return true
    return task.type === 'in_process_teammate'
      && text.startsWith(`<${TEAMMATE_MESSAGE_TAG} `)
      && text.includes(`\n${prompt}\n</${TEAMMATE_MESSAGE_TAG}>`)
  })
  if (hasPrompt) return messages

  return [{
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
    parent_tool_use_id: null,
    uuid: `desktop-task-prompt-${task.id}`,
  } as SDKMessage, ...messages]
}

async function taskMessages(task: TaskState): Promise<SDKMessage[]> {
  const inMemory = taskMessagesInMemory(task)
  const agentId = taskTranscriptAgentId(task)
  const transcript = agentId
    ? await getAgentTranscript(asAgentId(agentId)).catch(() => null)
    : null
  const persisted = transcript ? toSDKMessages(transcript.messages) : []
  return ensureTaskPrompt(task, mergeTaskMessages(persisted, inMemory))
}

function taskTranscriptAvailable(task: TaskState): boolean {
  return (
    taskMessagesInMemory(task).length > 0
    || taskTranscriptAgentId(task) !== undefined
  )
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
    transcriptAvailable: taskTranscriptAvailable(task),
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

export async function resolveRuntimeSubagentTranscript(
  appState: AppState,
  executionNodeId: string,
): Promise<RuntimeSubagentTranscript> {
  const task = appState.tasks[executionNodeId]
  if (task) {
    return {
      executionNodeId,
      messages: await taskMessages(task),
    }
  }

  // LocalAgent 的 task id 与 agentId 一致。即使 CCB 已从 AppState 回收
  // 完成节点，Desktop 仍可直接读取磁盘上的 sidechain Transcript。
  const transcript = await getAgentTranscript(
    asAgentId(executionNodeId),
  ).catch(() => null)
  if (!transcript) {
    throw new Error(`执行节点不存在或 Transcript 尚未写入: ${executionNodeId}`)
  }
  return {
    executionNodeId,
    messages: toSDKMessages(transcript.messages),
  }
}
