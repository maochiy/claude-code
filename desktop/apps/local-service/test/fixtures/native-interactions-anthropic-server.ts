import type { JsonValue } from '@proma/desktop-protocol'

interface ToolCall {
  name: string
  input: Record<string, JsonValue>
}

export interface NativeInteractionRequest {
  body: JsonValue
  scenario: string
  ordinal: number
  receivedAtMs: number
  firstEventAtMs?: number
  firstEventDelayMs?: number
}

export interface NativeInteractionsAnthropicServer {
  readonly baseUrl: string
  readonly requests: NativeInteractionRequest[]
  stop(): void
}

export interface NativeInteractionsAnthropicServerOptions {
  /** 每个 SSE 事件之间的延迟。集成测试默认不延迟，UI fixture 显式开启。 */
  eventDelayMs?: number
  /** 手动鼠标验收需要足够时间观察并单停任务；自动测试仍用短延迟。 */
  backgroundTaskDelaySeconds?: number
  onFirstEvent?: (request: NativeInteractionRequest) => void
}

const scenarioPattern = /NATIVE_INTERACTION_[A-Z_]+/

function findScenario(body: JsonValue): string {
  return scenarioPattern.exec(JSON.stringify(body))?.[0] ?? 'NATIVE_INTERACTION_UNKNOWN'
}

function requestedPath(body: JsonValue): string {
  const match = /TARGET_PATH=([^\s"\\]+)/.exec(JSON.stringify(body))
  if (!match?.[1]) throw new Error('Native interaction fixture message is missing TARGET_PATH')
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
      model: 'claude-native-interactions-fixture',
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

function textStream(text: string): string[] {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  const textChunks = text.match(/.{1,14}/gu) ?? [text]
  return [
    messageStart(messageId),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...textChunks.map(chunk => sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    })),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ]
}

function toolStream(tool: ToolCall): string[] {
  return toolsStream([tool])
}

function toolsStream(tools: ToolCall[]): string[] {
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
  const blocks = tools.flatMap((tool, index) => {
    const toolUseId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`
    return [
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: tool.name,
          input: {},
        },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(tool.input),
        },
      }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index }),
    ]
  })
  return [
    messageStart(messageId),
    ...blocks,
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 10 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function responseFor(
  request: NativeInteractionRequest,
  options: NativeInteractionsAnthropicServerOptions,
): string[] {
  if (request.scenario === 'NATIVE_INTERACTION_EXIT_PLAN') {
    if (request.ordinal === 1) {
      return toolStream({
        name: 'ExitPlanMode',
        input: { plan: 'Initial isolated implementation plan.' },
      })
    }
    if (request.ordinal === 2) {
      return toolStream({
        name: 'ExitPlanMode',
        input: { plan: 'Revised isolated plan with validation.' },
      })
    }
    if (request.ordinal === 3) {
      return toolStream({
        name: 'Write',
        input: {
          file_path: requestedPath(request.body),
          content: 'exit-plan-approved\n',
        },
      })
    }
    return textStream('ExitPlan fixture implementation completed.')
  }

  if (request.scenario.startsWith('NATIVE_INTERACTION_MCP_READ')) {
    return request.ordinal === 1
      ? toolStream({ name: 'mcp__native_interactions__read_value', input: {} })
      : textStream('MCP read fixture completed.')
  }

  if (request.scenario.startsWith('NATIVE_INTERACTION_MCP_WRITE')) {
    return request.ordinal === 1
      ? toolStream({ name: 'mcp__native_interactions__write_value', input: {} })
      : textStream('MCP write fixture completed.')
  }

  if (
    request.scenario === 'NATIVE_INTERACTION_ASK_MULTI' ||
    request.scenario === 'NATIVE_INTERACTION_ASK_CANCEL'
  ) {
    return request.ordinal === 1
      ? toolStream({
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which isolated implementation should be used?',
                header: 'Implementation',
                options: [
                  { label: 'Alpha', description: 'Use isolated Alpha.' },
                  { label: 'Beta', description: 'Use isolated Beta.' },
                ],
                multiSelect: false,
              },
              {
                question: 'Which isolated checks should run?',
                header: 'Checks',
                options: [
                  { label: 'Types', description: 'Run isolated type checks.' },
                  { label: 'Tests', description: 'Run isolated tests.' },
                ],
                multiSelect: true,
              },
            ],
          },
        })
      : textStream(`AskUser fixture completed: ${request.scenario}`)
  }

  if (request.scenario === 'NATIVE_INTERACTION_UI_TEXT') {
    return textStream('这是隔离 UI fixture 的持续流式正文。每个文本片段都会按固定延迟送达。')
  }

  if (request.scenario === 'NATIVE_INTERACTION_UI_TOOL') {
    return request.ordinal === 1
      ? toolStream({
          name: 'Read',
          input: { file_path: requestedPath(request.body) },
        })
      : textStream('隔离文件读取工具已完成。')
  }

  if (request.scenario === 'NATIVE_INTERACTION_UI_BACKGROUND_TASKS') {
    if (request.ordinal === 1) {
      const projectPath = requestedPath(request.body)
      const delaySeconds = Math.max(1, Math.floor(options.backgroundTaskDelaySeconds ?? 1))
      const firstMarker = shellQuote(`${projectPath}/background-task-a.txt`)
      const secondMarker = shellQuote(`${projectPath}/background-task-b.txt`)
      return toolsStream([
        {
          name: 'Bash',
          input: {
            command: `sleep ${delaySeconds}; printf 'fixture background task A\\n' > ${firstMarker}`,
            description: '运行隔离后台任务 A',
            run_in_background: true,
          },
        },
        {
          name: 'Bash',
          input: {
            command: `sleep ${delaySeconds * 2}; printf 'fixture background task B\\n' > ${secondMarker}`,
            description: '运行隔离后台任务 B',
            run_in_background: true,
          },
        },
      ])
    }
    return textStream('两个隔离后台任务均已提交。')
  }

  return textStream(`Unknown fixture scenario: ${request.scenario}`)
}

function createEventStream(
  events: string[],
  request: NativeInteractionRequest,
  options: NativeInteractionsAnthropicServerOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const delayMs = Math.max(0, options.eventDelayMs ?? 0)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const event of events) {
          if (delayMs > 0) await Bun.sleep(delayMs)
          controller.enqueue(encoder.encode(event))
          if (request.firstEventAtMs === undefined) {
            request.firstEventAtMs = Date.now()
            request.firstEventDelayMs = request.firstEventAtMs - request.receivedAtMs
            options.onFirstEvent?.(request)
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

export function startNativeInteractionsAnthropicServer(
  options: NativeInteractionsAnthropicServerOptions = {},
): NativeInteractionsAnthropicServer {
  const requests: NativeInteractionRequest[] = []
  const counts = new Map<string, number>()
  const fetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/fixture/health') {
        return Response.json({ ok: true })
      }
      if (url.pathname === '/fixture/requests') {
        return Response.json(requests.map(({ body: _body, ...record }) => record))
      }
      if (url.pathname.endsWith('/count_tokens')) {
        return Response.json({ input_tokens: 12 })
      }
      if (!url.pathname.endsWith('/messages') || request.method !== 'POST') {
        return Response.json({ error: { message: 'not found' } }, { status: 404 })
      }

      const body = (await request.json()) as JsonValue
      const scenario = findScenario(body)
      const ordinal = (counts.get(scenario) ?? 0) + 1
      counts.set(scenario, ordinal)
      const fakeRequest: NativeInteractionRequest = {
        body,
        scenario,
        ordinal,
        receivedAtMs: Date.now(),
      }
      requests.push(fakeRequest)

      return new Response(createEventStream(responseFor(fakeRequest, options), fakeRequest, options), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'request-id': `req_${crypto.randomUUID().replaceAll('-', '')}`,
        },
      })
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch,
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}
