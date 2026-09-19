import { LineDecoder } from '../../src/line-decoder.ts'

interface RecordValue {
  [key: string]: unknown
}

const sessionFlag = process.argv.indexOf('--session-id')
const resumeFlag = process.argv.indexOf('--resume')
const sessionId =
  (sessionFlag >= 0 ? process.argv[sessionFlag + 1] : undefined) ??
  (resumeFlag >= 0 ? process.argv[resumeFlag + 1] : undefined) ??
  crypto.randomUUID()

function write(value: RecordValue): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function writeSplit(value: RecordValue): void {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`)
  const marker = Math.max(1, bytes.indexOf(0xe4) + 1)
  process.stdout.write(bytes.slice(0, marker))
  setTimeout(() => process.stdout.write(bytes.slice(marker)), 5)
}

function system(subtype: string, fields: RecordValue = {}): RecordValue {
  return {
    type: 'system',
    subtype,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    ...fields,
  }
}

writeSplit(
  system('init', {
    claude_code_version: 'fake-1.0.0',
    cwd: process.cwd(),
    model: 'fake-model-中文',
    permissionMode: 'default',
    tools: ['Read', 'Bash'],
    mcp_servers: [],
    slash_commands: ['compact', 'plan'],
    output_style: 'default',
    skills: [],
    plugins: [],
    apiKeySource: 'none',
    launch_args: process.argv.slice(2),
  }),
)
process.stderr.write('fake cli ready\n')
await Bun.sleep(10)

const decoder = new LineDecoder()
const reader = Bun.stdin.stream().getReader()
let pendingPermission: string | null = null
const activeTaskIds = new Set<string>()

function finishRun(result = '完成', emitIdle = true): void {
  write({
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  })
  if (emitIdle) write(system('session_state_changed', { state: 'idle' }))
}

async function handle(line: string): Promise<void> {
  if (!line) return
  const parsed = JSON.parse(line) as RecordValue
  if (parsed.type === 'control_request') {
    const request = parsed.request as RecordValue
    const requestId = String(parsed.request_id)
    if (request.subtype === 'interrupt') {
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: {} },
      })
      write({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 1,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: 'interrupt',
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ['interrupted'],
        uuid: crypto.randomUUID(),
        session_id: sessionId,
      })
      write(system('session_state_changed', { state: 'idle' }))
      return
    }
    if (request.subtype === 'stop_task') {
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: {} },
      })
      const taskId = String(request.task_id)
      if (activeTaskIds.has(taskId)) {
        activeTaskIds.delete(taskId)
        write(
          system('task_notification', {
            task_id: taskId,
            status: 'stopped',
            output_file: process.env.FAKE_TASK_OUTPUT_PATH ?? '',
            summary: 'stopped',
          }),
        )
      }
      return
    }
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          request.subtype === 'initialize'
            ? {
                commands: [{ name: 'compact', description: 'compact' }],
                agents: [],
                output_style: 'default',
                available_output_styles: ['default'],
                models: [{ value: 'fake-model', displayName: 'Fake' }],
                account: {},
                pid: process.pid,
              }
            : { applied: true },
      },
    })
    return
  }
  if (parsed.type === 'control_response') {
    const response = parsed.response as RecordValue
    if (String(response.request_id) === pendingPermission) {
      pendingPermission = null
      write({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'permission accepted' }],
        },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: sessionId,
      })
      finishRun('permission accepted')
    }
    return
  }
  if (parsed.type !== 'user') return

  write({ ...parsed, uuid: parsed.uuid, session_id: sessionId, isReplay: true })
  const message = parsed.message as RecordValue
  const content = message.content
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  write(system('session_state_changed', { state: 'running' }))
  if (text.includes('cancel control')) {
    const cancelledRequestId = crypto.randomUUID()
    write({
      type: 'control_request',
      request_id: cancelledRequestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'printf cancelled' },
        tool_use_id: crypto.randomUUID(),
      },
    })
    await Bun.sleep(10)
    write({
      type: 'control_cancel_request',
      request_id: cancelledRequestId,
    })
    finishRun('control cancelled')
    return
  }
  if (text.includes('permission')) {
    pendingPermission = crypto.randomUUID()
    write({
      type: 'control_request',
      request_id: pendingPermission,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'printf safe' },
        tool_use_id: crypto.randomUUID(),
      },
    })
    write(system('session_state_changed', { state: 'requires_action' }))
    return
  }
  if (text.includes('hang')) return
  if (text.includes('crash process')) {
    process.exit(2)
  }
  if (text.includes('result without idle')) {
    finishRun('result terminal event', false)
    return
  }
  if (text.includes('two tasks')) {
    for (const taskId of ['task-1', 'task-2']) {
      activeTaskIds.add(taskId)
      write(
        system('task_started', {
          task_id: taskId,
          tool_use_id: `tool-${taskId}`,
          description: `background ${taskId}`,
        }),
      )
    }
    finishRun('two tasks started')
    return
  }
  if (text.includes('background')) {
    const activeTaskId = 'task-1'
    activeTaskIds.add(activeTaskId)
    const outputPath = process.env.FAKE_TASK_OUTPUT_PATH
    if (outputPath) await Bun.write(outputPath, 'line 1\n中文 output\n')
    write(
      system('task_started', {
        task_id: activeTaskId,
        tool_use_id: 'tool-1',
        description: 'background work',
      }),
    )
    write(
      system('task_progress', {
        task_id: activeTaskId,
        description: 'working',
        usage: { total_tokens: 4, tool_uses: 1, duration_ms: 10 },
      }),
    )
    await Bun.sleep(20)
    write(
      system('task_notification', {
        task_id: activeTaskId,
        tool_use_id: 'tool-1',
        status: 'completed',
        output_file: outputPath ?? '',
        summary: 'done',
      }),
    )
    activeTaskIds.delete(activeTaskId)
  }
  writeSplit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `回复：${text}` }],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  })
  await Bun.sleep(10)
  finishRun(`回复：${text}`)
}

try {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.push(value)) await handle(line)
  }
  for (const line of decoder.finish()) await handle(line)
} finally {
  reader.releaseLock()
}
