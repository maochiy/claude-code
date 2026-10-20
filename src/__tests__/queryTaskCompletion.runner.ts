import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { cleanupTempDir, createTempDir } from '../../tests/mocks/file-system'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
  setIsInteractive,
} from '../bootstrap/state'
import { query } from '../query'
import { TaskCompletionTracker } from '../query/taskCompletion'
import { getEmptyToolPermissionContext } from '../Tool'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '../utils/messages'
import { asSystemPrompt } from '../utils/systemPromptType'
import { createTask, getTask, getTaskListId, updateTask } from '../utils/tasks'
import { TaskUpdateTool } from '../../packages/builtin-tools/src/tools/TaskUpdateTool/TaskUpdateTool'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'

let tempDir: string
let previousEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  previousEnv = { ...process.env }
  tempDir = await createTempDir('query-task-completion-')
  process.env.CLAUDE_CONFIG_DIR = tempDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = randomUUID()
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  resetStateForTests()
  setOriginalCwd(tempDir)
  setCwdState(tempDir)
  setProjectRoot(tempDir)
})
afterEach(async () => {
  process.env = previousEnv
  resetStateForTests()
  await cleanupTempDir(tempDir)
})

function context(): any {
  let appState: any = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    mcp: { tools: [], clients: [] },
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5-20250929',
      tools: [TaskUpdateTool],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: any) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}
function use(taskId: string, id = 'update'): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'TaskUpdate',
    caller: { type: 'direct' },
    input: { taskId, status: 'in_progress' },
  }
}
function result(
  taskId: string,
  text = `Updated task #${taskId} status`,
  isError = false,
) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'update',
        content: text,
        is_error: isError,
      },
    ],
  })
}
async function fixture(
  status: 'pending' | 'in_progress' | 'completed' = 'in_progress',
  owner?: string,
) {
  return createTask(getTaskListId(), {
    subject: 'Implement requested change',
    description: 'Real task fixture',
    status,
    owner,
    blocks: [],
    blockedBy: [],
  })
}

describe('TaskCompletionTracker with persisted tasks', () => {
  test('only reminds once about successful updates, excluding historical, pending and other-owner tasks', async () => {
    const id = await fixture()
    const historical = await fixture()
    const pending = await fixture('pending')
    const other = await fixture('in_progress', 'someone-else')
    const tracker = new TaskCompletionTracker()
    for (const taskId of [id, pending, other])
      tracker.record(getTaskListId(), [use(taskId)], [result(taskId)])
    const reminder = await tracker.reminder(context())
    expect(reminder).toContain(`#${id}`)
    expect(reminder).not.toContain(`#${historical}`)
    expect(reminder).not.toContain(`#${pending}`)
    expect(reminder).not.toContain(`#${other}`)
    expect(reminder).toContain('keep its truthful status')
    expect(await tracker.reminder(context())).toBeUndefined()
    expect((await getTask(getTaskListId(), id))?.status).toBe('in_progress')
  })
  test('rejects failed/mismatched results and malformed inputs, and isolates task lists', async () => {
    const id = await fixture()
    const tracker = new TaskCompletionTracker()
    tracker.record(getTaskListId(), [use(id)], [result(id, 'Task not found')])
    tracker.record(getTaskListId(), [use(id)], [result(id, undefined, true)])
    tracker.record(getTaskListId(), [use(id, 'unmatched')], [result(id)])
    tracker.record(getTaskListId(), [{ ...use(id), input: null }], [result(id)])
    expect(await tracker.reminder(context())).toBeUndefined()
    tracker.record('different-list', [use(id)], [result(id)])
    expect(await tracker.reminder(context())).toBeUndefined()
    tracker.record(getTaskListId(), [use(id)], [result(id)])
    await updateTask(getTaskListId(), id, { status: 'completed' })
    expect(await tracker.reminder(context())).toBeUndefined()
  })
})

for (const mode of [
  'unfinished',
  'complete',
  'maxTurns',
  'noTool',
  'subagent',
  'apiError',
  'abort',
  'compact',
  'repl',
  'sideQuery',
  'alreadyCompleted',
  'tasksDisabled',
  'lastTurn',
] as const) {
  test(`query loop task reconciliation: ${mode}`, async () => {
    const id = await fixture('pending')
    const ctx = context()
    if (mode === 'subagent') ctx.agentId = 'worker'
    if (mode === 'tasksDisabled') {
      delete process.env.CLAUDE_CODE_ENABLE_TASKS
      setIsInteractive(false)
    }
    let calls = 0
    const requests: any[][] = []
    const deps = {
      uuid: randomUUID,
      microcompact: async (messages: unknown[]) => ({ messages }),
      autocompact: async () => ({
        compactionResult:
          mode === 'compact' && calls === 1
            ? {
                boundaryMarker: createUserMessage({
                  content: 'Compaction boundary',
                  isMeta: true,
                }),
                summaryMessages: [
                  createUserMessage({ content: 'Compacted context' }),
                ],
                attachments: [],
                hookResults: [],
                preCompactTokenCount: 100,
                postCompactTokenCount: 10,
              }
            : undefined,
        consecutiveFailures: 0,
      }),
      callModel: async function* (params: any) {
        calls++
        requests.push(params.messages)
        if (calls === 1) {
          yield createAssistantMessage({
            content: [
              {
                ...use(id),
                input: {
                  taskId: id,
                  status:
                    mode === 'alreadyCompleted' ? 'completed' : 'in_progress',
                },
              },
            ],
          })
        } else if (calls === 2 && mode === 'apiError') {
          yield createAssistantAPIErrorMessage({
            content: 'API Error',
            apiError: 'api_error',
          })
        } else {
          if (calls === 2 && mode === 'noTool') ctx.options.tools = []
          if (calls === 2 && mode === 'abort') ctx.abortController.abort()
          if (calls === 3 && mode === 'complete') {
            yield createAssistantMessage({
              content: [
                {
                  ...use(id, 'completed-update'),
                  input: { taskId: id, status: 'completed' },
                },
              ],
            })
          } else {
            yield createAssistantMessage({
              content: 'Implementation done, verification is blocked.',
            })
          }
        }
      },
    }
    const emitted: any[] = []
    const generator = query({
      messages: [createUserMessage({ content: 'Implement the change' })],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toolUseContext: ctx,
      querySource:
        mode === 'repl'
          ? 'repl_main_thread:opentui'
          : mode === 'sideQuery'
            ? 'agent:test'
            : 'sdk',
      maxTurns: mode === 'maxTurns' ? 2 : mode === 'lastTurn' ? 3 : 6,
      deps: deps as never,
    })
    let next = await generator.next()
    while (!next.done) {
      emitted.push(next.value)
      next = await generator.next()
    }
    const reminders = emitted.filter(
      m =>
        m.type === 'user' &&
        m.isMeta &&
        typeof m.message?.content === 'string' &&
        m.message.content.includes('Before finishing, reconcile'),
    )
    const shouldRemind = [
      'unfinished',
      'complete',
      'compact',
      'repl',
      'lastTurn',
    ].includes(mode)
    expect(reminders).toHaveLength(shouldRemind ? 1 : 0)
    if (shouldRemind) {
      if (mode !== 'compact') expect(requests[2]).toContainEqual(reminders[0])
      else
        expect(
          requests[2]?.some(m => m.message?.content === 'Compacted context'),
        ).toBe(true)
      expect(calls).toBe(mode === 'complete' ? 4 : 3)
    }
    expect((await getTask(getTaskListId(), id))?.status).toBe(
      mode === 'complete' || mode === 'alreadyCompleted'
        ? 'completed'
        : 'in_progress',
    )
  })
}
