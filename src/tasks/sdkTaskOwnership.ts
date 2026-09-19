import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { SdkTaskSnapshot } from './sdkTaskControls.js'

const safeId = /^[A-Za-z0-9_-]{1,128}$/
const taskTypes = new Set([
  'local_bash',
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
])
const statuses = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
])

/** 与当前原生会话同目录的只读授权索引；不能根据任意 taskId 猜测其它会话的文件。 */
export function readTaskOwnership(path: string): SdkTaskSnapshot[] {
  if (!existsSync(path)) return []
  const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    throw new Error('Invalid session task index')
  const root = stored as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.tasks))
    throw new Error('Unsupported session task index')
  for (const value of root.tasks) {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid session task entry')
    const item = value as Record<string, unknown>
    if (
      typeof item.task_id !== 'string' ||
      !safeId.test(item.task_id) ||
      !taskTypes.has(String(item.task_type)) ||
      !statuses.has(String(item.status)) ||
      typeof item.description !== 'string' ||
      typeof item.start_time !== 'number' ||
      (item.agent_id !== undefined &&
        (typeof item.agent_id !== 'string' ||
          !/^[A-Za-z0-9_@.-]{1,256}$/.test(item.agent_id) ||
          item.agent_id.includes('..'))) ||
      (item.parent_task_id !== undefined &&
        (typeof item.parent_task_id !== 'string' ||
          !safeId.test(item.parent_task_id))) ||
      !Array.isArray(item.child_task_ids) ||
      item.child_task_ids.some(id => typeof id !== 'string' || !safeId.test(id))
    )
      throw new Error('Invalid session task identity')
  }
  return root.tasks as SdkTaskSnapshot[]
}

export function persistTaskOwnership(
  path: string,
  snapshots: SdkTaskSnapshot[],
): void {
  if (!snapshots.length) return
  const saved = readTaskOwnership(path)
  const tasks = new Map(saved.map(task => [task.task_id, task]))
  for (const task of snapshots) {
    const previous = tasks.get(task.task_id)
    tasks.set(task.task_id, {
      ...task,
      parent_task_id: task.parent_task_id ?? previous?.parent_task_id,
    })
  }
  // 父任务可能已离开实时状态；由会话完整索引重建双向关系。
  const owners = new Map(
    [...tasks.values()]
      .filter(
        task =>
          task.task_type === 'local_agent' ||
          task.task_type === 'in_process_teammate',
      )
      .filter(task => task.agent_id)
      .map(task => [task.agent_id!, task.task_id]),
  )
  for (const task of tasks.values()) {
    task.child_task_ids = []
    if (
      !task.parent_task_id &&
      task.agent_id &&
      ['local_bash', 'local_workflow', 'monitor_mcp'].includes(task.task_type)
    ) {
      task.parent_task_id = owners.get(task.agent_id)
    }
  }
  for (const task of tasks.values()) {
    if (task.parent_task_id && task.parent_task_id !== task.task_id) {
      tasks.get(task.parent_task_id)?.child_task_ids.push(task.task_id)
    }
  }
  for (const task of tasks.values()) task.child_task_ids.sort()
  const serialized = JSON.stringify({ version: 1, tasks: [...tasks.values()] })
  if (existsSync(path) && readFileSync(path, 'utf8') === serialized) return
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, serialized, { mode: 0o600 })
  renameSync(temporary, path)
}
