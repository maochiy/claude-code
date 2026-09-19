import type { JsonValue } from '@proma/desktop-protocol'

export type AutoClassifierScenario =
  | 'NATIVE_AUTO_ALLOW'
  | 'NATIVE_AUTO_BLOCK'
  | 'NATIVE_AUTO_UNAVAILABLE'

export interface AutoClassifierRequest {
  body: JsonValue
  scenario: AutoClassifierScenario | 'UNKNOWN'
  kind: 'main' | 'classifier'
}

export interface AutoClassifierFakeServer {
  readonly baseUrl: string
  readonly requests: AutoClassifierRequest[]
  stop(): void
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function findScenario(body: JsonValue): AutoClassifierRequest['scenario'] {
  const match = /NATIVE_AUTO_(ALLOW|BLOCK|UNAVAILABLE)/.exec(
    JSON.stringify(body),
  )
  return (match?.[0] as AutoClassifierScenario | undefined) ?? 'UNKNOWN'
}

function containsToolResult(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsToolResult)
  if (!isRecord(value)) return false
  if (value.type === 'tool_result') return true
  return Object.values(value).some(containsToolResult)
}

function isClassifierRequest(body: JsonValue): boolean {
  if (!isRecord(body)) return false
  const toolChoice = body.tool_choice
  if (isRecord(toolChoice) && toolChoice.name === 'classify_result') return true
  const tools = body.tools
  return (
    Array.isArray(tools) &&
    tools.some(tool => isRecord(tool) && tool.name === 'classify_result')
  )
}

function targetPath(body: JsonValue): string {
  const match = /TARGET_PATH=([^\s"\\]+)/.exec(JSON.stringify(body))
  if (!match?.[1]) throw new Error('Auto classifier fixture 缺少 TARGET_PATH')
  return match[1]
}

function sseEvent(event: string, data: JsonValue): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(messageId: string): string {
  return sseEvent('message_start', {
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
        input_tokens: 12,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

function textStream(text: string): string {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  return [
    messageStart(messageId),
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

function toolStream(
  name: string,
  input: Record<string, JsonValue>,
): string {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  const toolUseId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`
  return [
    messageStart(messageId),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(input),
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

function toolMessage(
  name: string,
  input: Record<string, JsonValue>,
): JsonValue {
  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-fake-local',
    content: [
      {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
        name,
        input,
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

export function startAutoClassifierFakeServer(): AutoClassifierFakeServer {
  const requests: AutoClassifierRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/count_tokens')) {
        return Response.json({ input_tokens: 12 })
      }
      if (!url.pathname.endsWith('/messages') || request.method !== 'POST') {
        return Response.json(
          { error: { message: 'not found' } },
          { status: 404 },
        )
      }

      const body = (await request.json()) as JsonValue
      const scenario = findScenario(body)
      const kind = isClassifierRequest(body) ? 'classifier' : 'main'
      requests.push({ body, scenario, kind })

      if (kind === 'classifier') {
        if (scenario === 'NATIVE_AUTO_UNAVAILABLE') {
          return Response.json(
            { type: 'error', error: { type: 'api_error', message: 'fixture unavailable' } },
            { status: 500 },
          )
        }
        const shouldBlock = scenario === 'NATIVE_AUTO_BLOCK'
        return Response.json(
          toolMessage('classify_result', {
            thinking: 'Local deterministic classifier fixture.',
            shouldBlock,
            reason: shouldBlock
              ? 'Blocked by local classifier fixture.'
              : 'Allowed by local classifier fixture.',
          }),
          { headers: { 'request-id': `req_${crypto.randomUUID().replaceAll('-', '')}` } },
        )
      }

      const stream = containsToolResult(body)
        ? textStream(`fixture complete: ${scenario}`)
        : toolStream('Bash', {
            command: `/usr/bin/python3 -c "from pathlib import Path; Path('${targetPath(body)}').write_text('${scenario}')"`,
            description: 'Write deterministic auto classifier marker',
          })
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
