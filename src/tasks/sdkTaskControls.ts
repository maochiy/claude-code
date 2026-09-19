import { persistTaskOwnership, readTaskOwnership } from './sdkTaskOwnership.js'
import { open, stat } from 'fs/promises'
import type { AppState } from '../state/AppState.js'
import type { TaskStatus, TaskType } from '../Task.js'
import { asAgentId, toAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import {
  getAgentTranscript,
  getAgentTranscriptPath,
  getTranscriptPath,
} from '../utils/sessionStorage.js'
import {
  flushTaskOutput,
  getTaskOutputPath,
  getTaskOutputSize,
} from '../utils/task/diskOutput.js'
import {
  getTaskListId,
  listTasks,
  type Task as NativeTodoTask,
} from '../utils/tasks.js'

const DEFAULT_TASK_OUTPUT_BYTE_LIMIT = 64 * 1024
const MIN_TASK_OUTPUT_BYTE_LIMIT = 4
const MAX_TASK_OUTPUT_BYTE_LIMIT = 8 * 1024 * 1024
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type StoredTask = AppState['tasks'][string]

export interface TaskFileFacts {
  outputBytes: number
  outputAvailable: boolean
  transcriptAvailable: boolean
}

export interface SdkTaskSnapshot {
  task_id: string
  task_type: TaskType
  status: TaskStatus
  description: string
  tool_use_id?: string
  start_time: number
  end_time?: number
  duration_ms: number
  output_bytes: number
  parent_task_id?: string
  child_task_ids: string[]
  agent_id?: string
  agent_type?: string
  model?: string
  output_available: boolean
  transcript_available: boolean
}

export interface SdkTaskSnapshotResponse {
  captured_at: number
  tasks: SdkTaskSnapshot[]
  todos: SdkTodoSnapshot[]
}

export interface SdkTodoSnapshot {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
}

export interface SdkTaskOutputResponse {
  task_id: string
  content: string
  cursor: number
  next_cursor: number
  bytes_read: number
  total_bytes: number
  eof: boolean
  task?: SdkTaskSnapshot
}

export interface SdkSubagentTranscriptResponse {
  task_id: string
  agent_id: string
  messages: Message[]
  content_replacements: unknown[]
  message_count: number
}

function assertSafeTaskId(taskId: string): void {
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid task ID: ${taskId}`)
  }
}

function getTaskAgentId(task: StoredTask): string | undefined {
  switch (task.type) {
    case 'local_agent':
      return task.agentId
    case 'in_process_teammate':
      return task.identity.agentId
    case 'local_bash':
    case 'local_workflow':
    case 'monitor_mcp':
      return task.agentId
    default:
      return undefined
  }
}

function getOwnedAgentId(task: StoredTask): string | undefined {
  if (task.type === 'local_agent') return task.agentId
  if (task.type === 'in_process_teammate') return task.identity.agentId
  return undefined
}

function getParentAgentId(task: StoredTask): string | undefined {
  if (
    task.type === 'local_bash' ||
    task.type === 'local_workflow' ||
    task.type === 'monitor_mcp'
  ) {
    return task.agentId
  }
  return undefined
}

function getTaskAgentType(task: StoredTask): string | undefined {
  if (task.type === 'local_agent') return task.agentType
  if (task.type === 'in_process_teammate') return task.identity.agentName
  return undefined
}

function getTaskModel(task: StoredTask): string | undefined {
  if (task.type === 'local_agent' || task.type === 'in_process_teammate') {
    return task.model
  }
  return undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function getTaskFileFacts(task: StoredTask): Promise<TaskFileFacts> {
  assertSafeTaskId(task.id)
  const outputPath = getTaskOutputPath(task.id)
  const outputAvailable = await pathExists(outputPath)
  const outputBytes = outputAvailable ? await getTaskOutputSize(task.id) : 0

  let transcriptAvailable = false
  if (task.type === 'local_agent') {
    const agentId = toAgentId(task.agentId)
    transcriptAvailable = agentId
      ? await pathExists(getAgentTranscriptPath(agentId))
      : false
  } else if (task.type === 'in_process_teammate') {
    transcriptAvailable = (task.messages?.length ?? 0) > 0
  }

  return { outputBytes, outputAvailable, transcriptAvailable }
}

/**
 * 将 AppState 中的任务投影为稳定的 SDK 快照。文件事实单独传入，方便恢复场景测试。
 */
export function buildSdkTaskSnapshots(
  tasks: AppState['tasks'],
  fileFacts: ReadonlyMap<string, TaskFileFacts>,
  capturedAt: number,
  todos: readonly NativeTodoTask[] = [],
): SdkTaskSnapshotResponse {
  const taskEntries = Object.entries(tasks)
  const taskIdByAgentId = new Map<string, string>()
  for (const [taskId, task] of taskEntries) {
    const agentId = getOwnedAgentId(task)
    if (agentId) taskIdByAgentId.set(agentId, taskId)
  }

  const parentByTaskId = new Map<string, string>()
  const childrenByTaskId = new Map<string, string[]>()
  for (const [taskId, task] of taskEntries) {
    const parentAgentId = getParentAgentId(task)
    const parentTaskId = parentAgentId
      ? taskIdByAgentId.get(parentAgentId)
      : undefined
    if (!parentTaskId || parentTaskId === taskId) continue
    parentByTaskId.set(taskId, parentTaskId)
    const children = childrenByTaskId.get(parentTaskId) ?? []
    children.push(taskId)
    childrenByTaskId.set(parentTaskId, children)
  }

  const snapshots = taskEntries.map(([taskId, task]) => {
    const facts = fileFacts.get(taskId) ?? {
      outputBytes: 0,
      outputAvailable: false,
      transcriptAvailable: false,
    }
    const elapsedUntil = task.endTime ?? capturedAt
    const durationMs = Math.max(
      0,
      elapsedUntil - task.startTime - (task.totalPausedMs ?? 0),
    )
    const agentId = getTaskAgentId(task)
    const agentType = getTaskAgentType(task)
    const model = getTaskModel(task)

    return {
      task_id: taskId,
      task_type: task.type,
      status: task.status,
      description: task.description,
      ...(task.toolUseId ? { tool_use_id: task.toolUseId } : {}),
      start_time: task.startTime,
      ...(task.endTime !== undefined ? { end_time: task.endTime } : {}),
      duration_ms: durationMs,
      output_bytes: facts.outputBytes,
      ...(parentByTaskId.has(taskId)
        ? { parent_task_id: parentByTaskId.get(taskId) }
        : {}),
      child_task_ids: [...(childrenByTaskId.get(taskId) ?? [])].sort(),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(agentType ? { agent_type: agentType } : {}),
      ...(model ? { model } : {}),
      output_available: facts.outputAvailable,
      transcript_available: facts.transcriptAvailable,
    } satisfies SdkTaskSnapshot
  })

  snapshots.sort((left, right) =>
    left.start_time === right.start_time
      ? left.task_id.localeCompare(right.task_id)
      : left.start_time - right.start_time,
  )
  return {
    captured_at: capturedAt,
    tasks: snapshots,
    todos: todos
      .filter(todo => !todo.metadata?._internal)
      .map(todo => ({
        id: todo.id,
        subject: todo.subject,
        status: todo.status,
        ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
        ...(todo.owner ? { owner: todo.owner } : {}),
        blocks: [...todo.blocks],
        blockedBy: [...todo.blockedBy],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function taskOwnershipPath(): string {
  return `${getTranscriptPath()}.tasks.json`
}

export function persistSdkTaskOwnership(appState: AppState): void {
  const snapshots = buildSdkTaskSnapshots(
    appState.tasks,
    new Map(),
    Date.now(),
  ).tasks
  persistTaskOwnership(taskOwnershipPath(), snapshots)
}

export async function getSdkTaskSnapshots(
  appState: AppState,
  taskId?: string,
): Promise<SdkTaskSnapshotResponse> {
  const capturedAt = Date.now()
  if (taskId !== undefined) {
    assertSafeTaskId(taskId)
    if (
      !appState.tasks[taskId] &&
      !readTaskOwnership(taskOwnershipPath()).some(
        task => task.task_id === taskId,
      )
    ) {
      throw new Error(`No task found with ID: ${taskId}`)
    }
  }

  const selectedEntries = taskId
    ? appState.tasks[taskId]
      ? ([[taskId, appState.tasks[taskId]!]] as const)
      : []
    : Object.entries(appState.tasks)
  const facts = new Map<string, TaskFileFacts>()
  await Promise.all(
    selectedEntries.map(async ([id, task]) => {
      facts.set(id, await getTaskFileFacts(task))
    }),
  )
  const selectedTasks = Object.fromEntries(selectedEntries) as AppState['tasks']
  const todos = await listTasks(getTaskListId())
  const response = buildSdkTaskSnapshots(
    selectedTasks,
    facts,
    capturedAt,
    todos,
  )
  persistTaskOwnership(taskOwnershipPath(), response.tasks)
  const saved = readTaskOwnership(taskOwnershipPath())
  for (const task of response.tasks) {
    const owned = saved.find(item => item.task_id === task.task_id)
    if (owned) {
      task.parent_task_id = owned.parent_task_id
      task.child_task_ids = owned.child_task_ids
    }
  }
  const historic = saved.filter(
    task =>
      !appState.tasks[task.task_id] && (!taskId || task.task_id === taskId),
  )
  for (const task of historic) {
    const outputAvailable = await pathExists(getTaskOutputPath(task.task_id))
    response.tasks.push({
      ...task,
      status:
        task.status === 'running' || task.status === 'pending'
          ? 'killed'
          : task.status,
      output_available: outputAvailable,
      output_bytes: outputAvailable ? await getTaskOutputSize(task.task_id) : 0,
      transcript_available: Boolean(
        task.agent_id &&
          (await pathExists(getAgentTranscriptPath(asAgentId(task.agent_id)))),
      ),
    })
  }
  return response
}

function utf8SequenceLength(firstByte: number): number {
  if ((firstByte & 0x80) === 0) return 1
  if ((firstByte & 0xe0) === 0xc0) return 2
  if ((firstByte & 0xf0) === 0xe0) return 3
  if ((firstByte & 0xf8) === 0xf0) return 4
  return 1
}

function utf8SafePrefixLength(buffer: Buffer, reachesEnd: boolean): number {
  if (reachesEnd || buffer.length === 0) return buffer.length
  let sequenceStart = buffer.length - 1
  while (sequenceStart >= 0 && (buffer[sequenceStart]! & 0xc0) === 0x80) {
    sequenceStart -= 1
  }
  if (sequenceStart < 0) return 0
  const sequenceLength = utf8SequenceLength(buffer[sequenceStart]!)
  return sequenceStart + sequenceLength > buffer.length
    ? sequenceStart
    : buffer.length
}

/** @internal 供字节游标边界测试使用。 */
export async function readUtf8FileRange(
  path: string,
  cursor: number,
  byteLimit: number,
): Promise<Omit<SdkTaskOutputResponse, 'task_id' | 'task'>> {
  await using file = await open(path, 'r')
  const totalBytes = (await file.stat()).size
  if (cursor > totalBytes) {
    throw new Error(
      `Task output cursor ${cursor} exceeds output size ${totalBytes}`,
    )
  }
  if (cursor < totalBytes) {
    const boundary = Buffer.allocUnsafe(1)
    await file.read(boundary, 0, 1, cursor)
    if ((boundary[0]! & 0xc0) === 0x80) {
      throw new Error(`Task output cursor ${cursor} is not a UTF-8 boundary`)
    }
  }

  const requestedBytes = Math.min(byteLimit, totalBytes - cursor)
  const buffer = Buffer.allocUnsafe(requestedBytes)
  let totalRead = 0
  while (totalRead < requestedBytes) {
    const result = await file.read(
      buffer,
      totalRead,
      requestedBytes - totalRead,
      cursor + totalRead,
    )
    if (result.bytesRead === 0) break
    totalRead += result.bytesRead
  }
  const safeLength = utf8SafePrefixLength(
    buffer.subarray(0, totalRead),
    cursor + totalRead >= totalBytes,
  )
  const nextCursor = cursor + safeLength
  return {
    content: buffer.toString('utf8', 0, safeLength),
    cursor,
    next_cursor: nextCursor,
    bytes_read: safeLength,
    total_bytes: totalBytes,
    eof: nextCursor >= totalBytes,
  }
}

export async function getSdkTaskOutput(
  appState: AppState,
  taskId: string,
  cursor: number = 0,
  byteLimit: number = DEFAULT_TASK_OUTPUT_BYTE_LIMIT,
): Promise<SdkTaskOutputResponse> {
  assertSafeTaskId(taskId)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('Task output cursor must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < MIN_TASK_OUTPUT_BYTE_LIMIT ||
    byteLimit > MAX_TASK_OUTPUT_BYTE_LIMIT
  ) {
    throw new Error(
      `Task output byte_limit must be between ${MIN_TASK_OUTPUT_BYTE_LIMIT} and ${MAX_TASK_OUTPUT_BYTE_LIMIT}`,
    )
  }

  if (
    !appState.tasks[taskId] &&
    !readTaskOwnership(taskOwnershipPath()).some(
      task => task.task_id === taskId,
    )
  ) {
    throw new Error(`No task belongs to this session with ID: ${taskId}`)
  }
  await flushTaskOutput(taskId)
  const outputPath = getTaskOutputPath(taskId)
  if (!(await pathExists(outputPath))) {
    if (!appState.tasks[taskId]) {
      throw new Error(`No task found with ID: ${taskId}`)
    }
    return {
      task_id: taskId,
      content: '',
      cursor,
      next_cursor: cursor,
      bytes_read: 0,
      total_bytes: 0,
      eof: true,
      task: (await getSdkTaskSnapshots(appState, taskId)).tasks[0],
    }
  }

  const range = await readUtf8FileRange(outputPath, cursor, byteLimit)
  const task = appState.tasks[taskId]
    ? (await getSdkTaskSnapshots(appState, taskId)).tasks[0]
    : undefined
  return {
    task_id: taskId,
    ...range,
    ...(task ? { task } : {}),
  }
}

export async function getSdkSubagentTranscript(
  appState: AppState,
  taskId: string,
): Promise<SdkSubagentTranscriptResponse> {
  assertSafeTaskId(taskId)
  const task = appState.tasks[taskId]
  if (!task) {
    const saved = readTaskOwnership(taskOwnershipPath()).find(
      candidate => candidate.task_id === taskId,
    )
    if (
      !saved?.agent_id ||
      !['local_agent', 'in_process_teammate'].includes(saved.task_type)
    )
      throw new Error(
        `No subagent task belongs to this session with ID: ${taskId}`,
      )
    const transcript = await getAgentTranscript(asAgentId(saved.agent_id))
    if (!transcript) throw new Error(`No transcript found for task: ${taskId}`)
    return {
      task_id: taskId,
      agent_id: saved.agent_id,
      messages: transcript.messages,
      content_replacements: transcript.contentReplacements,
      message_count: transcript.messages.length,
    }
  }

  if (task.type === 'in_process_teammate') {
    const messages = [...(task.messages ?? [])]
    if (messages.length === 0) {
      throw new Error(`No transcript found for task: ${taskId}`)
    }
    return {
      task_id: taskId,
      agent_id: task.identity.agentId,
      messages,
      content_replacements: [],
      message_count: messages.length,
    }
  }
  if (task.type !== 'local_agent') {
    throw new Error(`Task ${taskId} does not have a subagent transcript`)
  }

  const agentId = toAgentId(task.agentId)
  if (!agentId) throw new Error(`Task ${taskId} has an invalid agent ID`)
  const transcript = await getAgentTranscript(asAgentId(agentId))
  if (!transcript) throw new Error(`No transcript found for task: ${taskId}`)
  return {
    task_id: taskId,
    agent_id: agentId,
    messages: transcript.messages,
    content_replacements: transcript.contentReplacements,
    message_count: transcript.messages.length,
  }
}
