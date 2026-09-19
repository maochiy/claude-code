import { appendFileSync } from 'node:fs'

interface RecordValue {
  [key: string]: unknown
}

class LineDecoder {
  private readonly decoder = new TextDecoder()
  private buffered = ''

  push(chunk: Uint8Array): string[] {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    const lines = this.buffered.split('\n')
    this.buffered = lines.pop() ?? ''
    return lines.map(line => line.replace(/\r$/, ''))
  }

  finish(): string[] {
    this.buffered += this.decoder.decode()
    const trailing = this.buffered.replace(/\r$/, '')
    this.buffered = ''
    return trailing ? [trailing] : []
  }
}

const sessionFlag = process.argv.indexOf('--session-id')
const resumeFlag = process.argv.indexOf('--resume')
const sessionId = sessionFlag >= 0
  ? String(process.argv[sessionFlag + 1])
  : resumeFlag >= 0
    ? String(process.argv[resumeFlag + 1])
    : crypto.randomUUID()
const tracePath = process.env.FAKE_CLI_TRACE_PATH
let pendingPermissionRequestId: string | null = null

function trace(event: RecordValue): void {
  if (!tracePath) return
  appendFileSync(tracePath, `${JSON.stringify(event)}\n`, 'utf8')
}

trace({ kind: 'startup', argv: process.argv.slice(2) })

function write(value: RecordValue): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function writeSplit(value: RecordValue): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`)
  const splitAt = Math.max(1, Math.floor(bytes.length / 2))
  process.stdout.write(bytes.slice(0, splitAt))
  await Bun.sleep(5)
  process.stdout.write(bytes.slice(splitAt))
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

function finishRun(result: string): void {
  write({
    type: 'result',
    subtype: 'success',
    duration_ms: 5,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  })
  write(system('session_state_changed', { state: 'idle' }))
}

function commandCatalog(directories: unknown): RecordValue[] {
  const hasSkills = Array.isArray(directories) && directories.length > 0
  return [
    { name: 'compact', description: 'Compact context', argumentHint: '' },
    ...(hasSkills
      ? [{ name: 'skill-fixture', description: 'Workspace skill', argumentHint: '' }]
      : []),
  ]
}

await writeSplit(system('init', {
  claude_code_version: 'runtime-adapter-fixture',
  cwd: process.cwd(),
  model: 'fake-local-model',
  permissionMode: 'default',
  tools: ['Read', 'Bash'],
  mcp_servers: [],
  slash_commands: ['compact'],
  output_style: 'default',
  skills: [],
  plugins: [],
  apiKeySource: 'none',
}))

async function handleControlRequest(parsed: RecordValue): Promise<void> {
  const request = parsed.request as RecordValue
  const requestId = String(parsed.request_id)
  trace({ kind: 'control_request', request })

  const delayedSubtype = process.env.FAKE_CLI_DELAY_CONTROL_SUBTYPE
  const delayMs = Number(process.env.FAKE_CLI_DELAY_CONTROL_MS ?? 0)
  if (request.subtype === delayedSubtype && Number.isFinite(delayMs) && delayMs > 0) {
    await Bun.sleep(delayMs)
  }

  if (request.subtype === 'get_session_transcript') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
      response: { snapshot_id: 'fixture-history', cursor: 0, next_cursor: 1, total: 1, eof: true, truncated: false,
        messages: [{ type: 'assistant', uuid: 'native-gap-message', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered gap' }] } }] } } })
    return
  }
  if (request.subtype === 'interrupt') {
    write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    })
    write({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: 'interrupt',
      errors: ['interrupted'],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    })
    write(system('session_state_changed', { state: 'idle' }))
    return
  }
  if (request.subtype === 'get_tasks') {
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { captured_at: Date.now(), tasks: [], todos: [] },
      },
    })
    return
  }

  const directories = request.subtype === 'initialize'
    ? request.additionalSkillDirectories
    : request.subtype === 'set_skill_directories'
      ? request.directories
      : undefined
  write({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: directories === undefined
        ? { applied: true }
        : {
            commands: commandCatalog(directories),
            receivedSkillDirectories: directories,
            models: [{ value: 'fake-local-model', displayName: 'Fake Local' }],
          },
    },
  })
}

function emitPermissionRequest(): void {
  pendingPermissionRequestId = crypto.randomUUID()
  write({
    type: 'control_request',
    request_id: pendingPermissionRequestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'printf safe' },
      tool_use_id: crypto.randomUUID(),
    },
  })
  write(system('session_state_changed', { state: 'requires_action' }))
}

async function emitStreamingReply(text: string): Promise<void> {
  const messageId = crypto.randomUUID()
  for (const event of [
    { type: 'message_start', message: { id: messageId, model: 'fake-local-model' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '实时' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '增量' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]) {
    await writeSplit({
      type: 'stream_event',
      event,
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    })
    await Bun.sleep(5)
  }
  write({
    type: 'assistant',
    message: {
      id: messageId,
      model: 'fake-local-model',
      role: 'assistant',
      content: [{ type: 'text', text: `实时增量：${text}` }],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  })
  finishRun(`实时增量：${text}`)
}

async function handleUserMessage(parsed: RecordValue): Promise<void> {
  const message = parsed.message as RecordValue
  const content = message.content
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  trace({ kind: 'user', uuid: parsed.uuid, text })
  // 模拟原生 CLI 对本轮输入的 replay；Adapter 不应因此再次向 CLI 发送。
  write({ ...parsed, isReplay: true, session_id: sessionId })
  write(system('session_state_changed', { state: 'running' }))

  if (text.includes('stream partial')) {
    await emitStreamingReply(text)
    return
  }
  if (text.includes('permission')) {
    emitPermissionRequest()
    return
  }
  if (text.includes('cancel control')) {
    const requestId = crypto.randomUUID()
    write({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'printf cancelled' },
        tool_use_id: crypto.randomUUID(),
      },
    })
    await Bun.sleep(15)
    write({ type: 'control_cancel_request', request_id: requestId })
    finishRun('control cancelled')
    return
  }
  if (text.includes('hang')) return

  await writeSplit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `回复：${text}` }],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  })
  finishRun(`回复：${text}`)
}

const decoder = new LineDecoder()
const reader = Bun.stdin.stream().getReader()
try {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.push(value)) {
      const parsed = JSON.parse(line) as RecordValue
      if (parsed.type === 'control_request') {
        if (process.env.FAKE_CLI_CONCURRENT_CONTROLS === '1') {
          void handleControlRequest(parsed)
        } else {
          await handleControlRequest(parsed)
        }
      } else if (parsed.type === 'control_response') {
        trace({ kind: 'control_response', response: parsed.response })
        const response = parsed.response as RecordValue
        if (String(response.request_id) === pendingPermissionRequestId) {
          pendingPermissionRequestId = null
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
      } else if (parsed.type === 'user') {
        await handleUserMessage(parsed)
      }
    }
  }
  for (const line of decoder.finish()) {
    const parsed = JSON.parse(line) as RecordValue
    if (parsed.type === 'user') await handleUserMessage(parsed)
  }
} finally {
  reader.releaseLock()
}
