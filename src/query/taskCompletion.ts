import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { getTaskListId, listTasks } from '../utils/tasks.js'
import { getAgentId, getAgentName } from '../utils/teammate.js'

// One instance per query, deliberately outside the compacted message state.
export class TaskCompletionTracker {
  private readonly touched = new Map<string, Set<string>>()
  private reminded = false

  record(listId: string, uses: ToolUseBlock[], results: Message[]): void {
    for (const use of uses) {
      if (use.name !== 'TaskUpdate') continue
      const input = use.input
      if (!input || typeof input !== 'object' || !('taskId' in input)) continue
      if (typeof input.taskId !== 'string') continue
      const taskId = input.taskId
      const succeeded = results.some(
        result =>
          result.type === 'user' &&
          !!result.message &&
          Array.isArray(result.message.content) &&
          result.message.content.some(
            block =>
              block.type === 'tool_result' &&
              block.tool_use_id === use.id &&
              !block.is_error &&
              (typeof block.content === 'string'
                ? block.content.startsWith(`Updated task #${taskId} `)
                : block.content?.some(
                    part =>
                      part.type === 'text' &&
                      part.text.startsWith(`Updated task #${taskId} `),
                  )),
          ),
      )
      if (!succeeded) continue
      const ids = this.touched.get(listId) ?? new Set<string>()
      ids.add(taskId)
      this.touched.set(listId, ids)
    }
  }

  async reminder(context: ToolUseContext): Promise<string | undefined> {
    if (this.reminded) return
    const listId = getTaskListId()
    const ids = this.touched.get(listId)
    if (!ids?.size) return
    const team = context.getAppState().teamContext
    const agentId = getAgentId()
    if (agentId && agentId !== team?.leadAgentId) return
    const owners = new Set([
      agentId,
      getAgentName(),
      ...(team
        ? [
            team.leadAgentId,
            team.teammates[team.leadAgentId]?.name ?? 'team-lead',
          ]
        : []),
    ])
    const tasks = (await listTasks(listId)).filter(
      task =>
        ids.has(task.id) &&
        task.status === 'in_progress' &&
        (!task.owner || owners.has(task.owner)),
    )
    // A list switch while reading must not remind about the previous list.
    if (!tasks.length || getTaskListId() !== listId) return
    this.reminded = true
    return (
      `Before finishing, reconcile the tasks you updated this turn that are still in_progress: ${tasks.map(task => `#${task.id}`).join(', ')}. ` +
      'If the requested work is actually complete, use TaskUpdate to mark it completed. ' +
      'If work is blocked, unfinished, or not yet verified, keep its truthful status and explain the blocker or remaining verification. ' +
      'Do not mark tasks completed just to clear the list, and do not start work the user did not request.'
    )
  }
}
