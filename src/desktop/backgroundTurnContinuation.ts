import type { RuntimeExecutionGraph } from './protocol/types.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

/** CCB 原生后台节点仍在执行时，Desktop Turn 不能提前结束。 */
export function hasActiveBackgroundExecutionNodes(
  graph: RuntimeExecutionGraph,
): boolean {
  return graph.nodes.some(
    node => node.status === 'queued' || node.status === 'running',
  )
}

/** 只消费发给主线程的后台完成通知，避免串入子智能体自己的队列消息。 */
export function isMainThreadTaskNotification(
  command: QueuedCommand,
): boolean {
  return (
    command.mode === 'task-notification' &&
    command.agentId === undefined &&
    typeof command.value === 'string'
  )
}

/** 将一个或多个完成通知合并为隐藏续轮，模型处理结果后继续父任务。 */
export function buildBackgroundContinuationPrompt(
  commands: readonly QueuedCommand[],
): string | undefined {
  const notifications = commands
    .filter(isMainThreadTaskNotification)
    .map(command => command.value as string)
  if (notifications.length === 0) return undefined
  return `${notifications.join('\n\n')}\n\n请处理以上后台子智能体通知，并继续完成当前任务。`
}
