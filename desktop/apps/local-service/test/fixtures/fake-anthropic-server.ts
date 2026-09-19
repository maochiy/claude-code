import type { JsonValue } from '@proma/desktop-protocol'

interface ToolCall {
  name: string
  input: Record<string, JsonValue>
}

interface FakeAnthropicRequest {
  body: JsonValue
  scenario: string
  hasToolResult: boolean
}

export interface FakeAnthropicServer {
  readonly baseUrl: string
  readonly requests: FakeAnthropicRequest[]
  stop(): void
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function findScenario(body: JsonValue): string {
  const serialized = JSON.stringify(body)
  const marker = /NATIVE_SCENARIO_[A-Z_]+/.exec(serialized)
  return marker?.[0] ?? 'NATIVE_SCENARIO_UNKNOWN'
}

function containsToolResult(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsToolResult)
  if (!isRecord(value)) return false
  if (value.type === 'tool_result') return true
  return Object.values(value).some(containsToolResult)
}

function requestedPath(body: JsonValue): string {
  if (!isRecord(body)) throw new Error('Fake Anthropic 请求体必须是对象')
  const serialized = JSON.stringify(body)
  const match = /TARGET_PATH=([^\s"\\]+)/.exec(serialized)
  if (!match?.[1]) throw new Error('场景消息缺少 TARGET_PATH')
  return match[1]
}

function scenarioTool(request: FakeAnthropicRequest): ToolCall | null {
  switch (request.scenario) {
    case 'NATIVE_SCENARIO_DEFAULT_WRITE':
    case 'NATIVE_SCENARIO_ACCEPT_WRITE':
    case 'NATIVE_SCENARIO_DONT_ASK': {
      const path = requestedPath(request.body)
      return {
        name: 'Write',
        input: { file_path: path, content: `${request.scenario}\n` },
      }
    }
    case 'NATIVE_SCENARIO_PLAN': {
      const path = requestedPath(request.body)
      return {
        name: 'Bash',
        input: {
          command: `printf plan-write > '${path}'`,
          description: 'Attempt fixture mutation in plan mode',
        },
      }
    }
    case 'NATIVE_SCENARIO_ACCEPT_BASH':
    case 'NATIVE_SCENARIO_BYPASS': {
      const path = requestedPath(request.body)
      return {
        name: 'Bash',
        input: {
          command: `python3 -c "from pathlib import Path; Path('${path}').write_text('written')"`,
          description: 'Write isolated fixture marker',
        },
      }
    }
    case 'NATIVE_SCENARIO_ASK_USER': {
      const question = 'Which isolated option should be used?'
      return {
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question,
              header: 'Fixture',
              options: [
                { label: 'Alpha', description: 'Use the alpha fixture.' },
                { label: 'Beta', description: 'Use the beta fixture.' },
              ],
              multiSelect: false,
            },
          ],
        },
      }
    }
    case 'NATIVE_SCENARIO_BACKGROUND': {
      const path = requestedPath(request.body)
      return {
        name: 'Bash',
        input: {
          command: `sleep 0.1; printf background > '${path}'`,
          description: 'Write background fixture marker',
          run_in_background: true,
        },
      }
    }
    case 'NATIVE_SCENARIO_SHUTDOWN_BACKGROUND': {
      const path = requestedPath(request.body)
      return {
        name: 'Bash',
        input: {
          command: `/usr/bin/python3 -c "import os,time; open(r'${path}','w').write(str(os.getpid())); time.sleep(300)"`,
          description: 'Run isolated background children for shutdown validation',
          run_in_background: true,
        },
      }
    }
    default:
      return null
  }
}

function sseEvent(event: string, data: JsonValue): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function textStream(text: string): string {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-fake-local',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function toolStream(tool: ToolCall): string {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  const toolUseId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-fake-local',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseId,
        name: tool.name,
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(tool.input),
      },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

export function startFakeAnthropicServer(): FakeAnthropicServer {
  const requests: FakeAnthropicRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/count_tokens')) {
        return Response.json({ input_tokens: 8 })
      }
      if (!url.pathname.endsWith('/messages') || request.method !== 'POST') {
        return Response.json({ error: { message: 'not found' } }, { status: 404 })
      }

      const body = (await request.json()) as JsonValue
      const fakeRequest: FakeAnthropicRequest = {
        body,
        scenario: findScenario(body),
        hasToolResult: containsToolResult(body),
      }
      requests.push(fakeRequest)
      const tool = scenarioTool(fakeRequest)
      const stream =
        tool && !fakeRequest.hasToolResult
          ? toolStream(tool)
          : textStream(`fixture complete: ${fakeRequest.scenario}`)
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'request-id': `req_${crypto.randomUUID().replaceAll('-', '')}`,
        },
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}
