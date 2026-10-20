import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { normalizeOpenAIUsage, type AnthropicUsage } from '@ant/model-provider'
import { getActiveProviderProxyUrl } from 'src/utils/model/providerProfiles.js'
import { getValidChatGPTAuth } from './chatgptAuth.js'
import { proxiedFetch } from './proxiedFetch.js'
import { sleep } from 'src/utils/sleep.js'

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = Record<string, unknown>
export type ResponsesReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

type ResponsesRequest = {
  model: string
  stream: true
  store: false
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: { effort: ResponsesReasoningEffort }
  parallel_tool_calls?: boolean
  /** Sticky cache routing key — stable for the CCB session. */
  prompt_cache_key: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function convertUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textFromContent(content)
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      result.push({ type: 'input_text', text: record.text })
    } else if (record.type === 'image_url') {
      const imageUrl = record.image_url as Record<string, unknown> | undefined
      if (typeof imageUrl?.url === 'string') {
        result.push({ type: 'input_image', image_url: imageUrl.url })
      }
    }
  }
  return result.length > 0 ? result : textFromContent(content)
}

function convertMessagesToResponsesInput(messages: unknown[]): {
  input: ResponsesInputItem[]
  instructions?: string
} {
  const input: ResponsesInputItem[] = []
  const instructions: string[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const role = record.role

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(record.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = record.tool_call_id
      if (typeof callId === 'string') {
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: textFromContent(record.content),
        })
      }
      continue
    }

    if (role === 'assistant') {
      const text = textFromContent(record.content)
      if (text) {
        input.push({ role: 'assistant', content: text })
      }
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const tc = toolCall as Record<string, unknown>
          const fn = tc.function as Record<string, unknown> | undefined
          const id = typeof tc.id === 'string' ? tc.id : undefined
          const name = typeof fn?.name === 'string' ? fn.name : undefined
          if (!id || !name) continue
          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          })
        }
      }
      continue
    }

    if (role === 'user') {
      input.push({
        role: 'user',
        content: convertUserContent(record.content),
      })
    }
  }

  return {
    input,
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
  }
}

function convertToolsToResponses(tools: unknown[]): ResponsesTool[] {
  const result: ResponsesTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    result.push({
      type: 'function',
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      strict: false,
    })
  }
  return result
}

function convertToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'required') return 'required'
  if (toolChoice === 'auto') return 'auto'
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  const record = toolChoice as Record<string, unknown>
  const fn = record.function as Record<string, unknown> | undefined
  if (record.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'function', name: fn.name }
  }
  return toolChoice
}

export function buildResponsesRequest(params: {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  /** Session-scoped key supplied only by the ChatGPT OAuth route. */
  promptCacheKey: string
}): ResponsesRequest {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
  return {
    model: params.model,
    stream: true,
    store: false,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(params.toolChoice
      ? { tool_choice: convertToolChoiceToResponses(params.toolChoice) }
      : {}),
    ...(params.reasoningEffort
      ? { reasoning: { effort: params.reasoningEffort } }
      : {}),
    parallel_tool_calls: true,
    // Same OAuth session → same key so OpenAI can sticky-route to a cache node.
    // Must not hash the full message list (would change every turn).
    prompt_cache_key: params.promptCacheKey,
  }
}

function isResponsesTerminal(type: unknown): boolean {
  return (
    type === 'response.completed' ||
    type === 'response.incomplete' ||
    type === 'response.failed' ||
    type === 'response.error' ||
    type === 'error'
  )
}

class ResponsesStreamInterruptedError extends Error {
  readonly code = 'CHATGPT_STREAM_INTERRUPTED'

  constructor() {
    super('ChatGPT Responses stream interrupted before a terminal event')
  }
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504])
const retryableNetworkCodes = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
])

function transportDetails(error: unknown): {
  code?: string
  status?: number
  network: boolean
} {
  let current = error
  let code: string | undefined
  let status: number | undefined
  let network = false
  const seen = new Set<unknown>()
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    if (typeof record.code === 'string') {
      code ??= record.code
      if (retryableNetworkCodes.has(record.code)) {
        code = record.code
        network = true
      }
    }
    if (typeof record.status === 'number') status ??= record.status
    current = record.cause
  }
  return { code, status, network }
}

async function* parseSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body) throw new ResponsesStreamInterruptedError()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
      // Match CRLF only after a complete chunk has arrived; a trailing CR may
      // belong to the next chunk's LF. Also process an unterminated EOF frame.
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer)) || (done && buffer)) {
        const frame = separator ? buffer.slice(0, separator.index) : buffer
        buffer = separator
          ? buffer.slice(separator.index + separator[0].length)
          : ''
        const data = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(data) as unknown
        } catch {
          // SyntaxError messages can quote the payload. Do not retain them,
          // even as a cause, since errors are exposed to users and logs.
          throw Object.assign(new Error('ChatGPT Responses invalid SSE JSON'), {
            code: 'CHATGPT_INVALID_SSE',
          })
        }
        if (parsed && typeof parsed === 'object') {
          const event = parsed as Record<string, unknown>
          yield event
          if (isResponsesTerminal(event.type)) return
        }
      }
      if (done) throw new ResponsesStreamInterruptedError()
    }
  } finally {
    // Every read above has settled before reaching finally. Initiate cancel,
    // but do not wait for an underlying source that may never finish cleanup.
    // releaseLock is safe here and must not depend on that cleanup promise.
    try {
      void reader.cancel().catch(() => {})
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * Map OpenAI Responses usage → Anthropic-style mutually exclusive fields.
 *
 * OpenAI:  input_tokens is TOTAL input; cached_tokens ⊆ input_tokens;
 *          cache_write_tokens (GPT-5.6+) reports tokens written this turn.
 * Anthropic: input + cache_creation + cache_read are disjoint and sum to total.
 *
 * Without subtracting cached from input, cacheWarning hit-rate becomes
 * cached/(total+cached) with a hard ceiling of 50%.
 */
export function extractUsage(
  response: Record<string, unknown> | undefined,
): AnthropicUsage {
  const usage = response?.usage as Record<string, unknown> | undefined
  const inputDetails = usage?.input_tokens_details as
    | Record<string, unknown>
    | undefined

  const totalInput =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0

  const cachedRaw =
    typeof inputDetails?.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : 0
  const writeRaw =
    typeof inputDetails?.cache_write_tokens === 'number'
      ? inputDetails.cache_write_tokens
      : 0

  return normalizeOpenAIUsage({
    totalInputTokens: totalInput,
    outputTokens,
    cacheReadTokens: cachedRaw,
    cacheWriteTokens: writeRaw,
  })
}

function mapStopReason(response: Record<string, unknown> | undefined): string {
  if (response?.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const toolBlocks = new Map<
    number,
    { contentIndex: number; open: boolean; name: string; id: string }
  >()
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false

  const ensureStarted = async function* () {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as BetaRawMessageStreamEvent
  }

  for await (const event of stream) {
    for await (const startedEvent of ensureStarted()) yield startedEvent
    const type = event.type

    if (type === 'response.output_text.delta') {
      if (!textBlockOpen) {
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        textBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.reasoning_text.delta') {
      if (!thinkingBlockOpen) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        currentContentIndex++
        thinkingBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'thinking_delta', thinking: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      if (item?.type === 'function_call' && outputIndex >= 0) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        const id = String(item.call_id ?? item.id ?? `call_${outputIndex}`)
        const name = String(item.name ?? '')
        toolBlocks.set(outputIndex, {
          contentIndex: currentContentIndex,
          open: true,
          name,
          id,
        })
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block) {
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: String(event.delta ?? ''),
          },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block?.open) {
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'response.error' || type === 'error') {
      const error = (event.error ?? event) as Record<string, unknown>
      throw Object.assign(
        new Error(String(error.message ?? 'ChatGPT Responses API error')),
        { code: error.code },
      )
    }

    if (type === 'response.failed') {
      const response = event.response as Record<string, unknown> | undefined
      const error = response?.error as Record<string, unknown> | undefined
      throw Object.assign(
        new Error(String(error?.message ?? 'ChatGPT Responses API failed')),
        { code: error?.code },
      )
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        textBlockOpen = false
      }
      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        thinkingBlockOpen = false
      }
      const response = event.response as Record<string, unknown> | undefined
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(response), stop_sequence: null },
        usage: extractUsage(response),
      } as unknown as BetaRawMessageStreamEvent
      yield { type: 'message_stop' } as BetaRawMessageStreamEvent
    }
  }
}

export async function createChatGPTResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const auth = await getValidChatGPTAuth()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    originator: 'claude-code-best',
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
  }
  // Preserve main's dedicated-agent proxy transport; fixtures bypass networking.
  const proxyUrl = params.fetchOverride
    ? undefined
    : getActiveProviderProxyUrl()
  const fetchFn =
    params.fetchOverride ??
    ((url: string, init: Parameters<typeof proxiedFetch>[1]) =>
      proxiedFetch(url, { ...init, proxyUrl }))
  const body = JSON.stringify(params.request)
  return (async function* () {
    let delivered = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      params.signal.throwIfAborted()
      try {
        const response = await fetchFn(
          'https://chatgpt.com/backend-api/codex/responses',
          { method: 'POST', headers, body, signal: params.signal },
        )
        if (!response.ok) {
          // Do not include upstream response bodies in errors/logs.
          void response.body?.cancel().catch(() => {})
          throw Object.assign(
            new Error(
              `ChatGPT Responses API request failed (${response.status})`,
            ),
            { status: response.status },
          )
        }
        for await (const event of parseSSE(response)) {
          params.signal.throwIfAborted()
          // Even metadata/tool fragments prohibit replay of this request.
          delivered = true
          yield event
        }
        return
      } catch (error) {
        if (params.signal.aborted) throw error
        const details = transportDetails(error)
        const aborted = error instanceof Error && error.name === 'AbortError'
        const fetchNetworkError =
          error instanceof TypeError &&
          /fetch failed|failed to fetch|network|load failed/i.test(
            error.message,
          )
        const retryable =
          (!aborted || details.network) &&
          (details.network ||
            fetchNetworkError ||
            (details.status !== undefined &&
              retryableStatuses.has(details.status)) ||
            error instanceof ResponsesStreamInterruptedError)
        if (!delivered && retryable && attempt < 3) {
          await sleep(attempt * 1000, params.signal)
          params.signal.throwIfAborted()
          continue
        }
        if (aborted && !details.network) throw error
        const diagnostic = details.code
          ? `code ${details.code}`
          : details.status !== undefined
            ? `HTTP ${details.status}`
            : error instanceof Error
              ? error.message
              : 'unknown transport error'
        const boundary = delivered
          ? 'stream interrupted after an event; request not replayed'
          : retryable
            ? `retries exhausted after ${attempt} attempts`
            : 'request failed'
        throw Object.assign(
          new Error(
            !delivered && !retryable && details.status !== undefined
              ? `ChatGPT Responses API request failed (${details.status})`
              : `ChatGPT Responses ${boundary} (${diagnostic})`,
            { cause: error },
          ),
          { code: details.code, status: details.status },
        )
      }
    }
  })()
}
