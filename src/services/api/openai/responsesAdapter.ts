import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  extractResponsesUsage,
  parseResponsesSSE,
  type ResponsesReasoningEffort,
  type ResponsesRequest,
} from '@ant/model-provider'
import { getValidChatGPTAuth } from './chatgptAuth.js'

export {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  extractResponsesUsage as extractUsage,
}
export type { ResponsesReasoningEffort, ResponsesRequest }

function normalizeResponsesEndpoint(baseUrl?: string): string {
  const normalized = (baseUrl?.trim() || 'https://api.openai.com/v1')
    .replace(/\/+$/, '')
    .replace(/\/responses$/i, '')
  return `${normalized}/responses`
}

async function requestResponsesStream(params: {
  endpoint: string
  request: ResponsesRequest
  signal: AbortSignal
  headers: Record<string, string>
  fetchOverride?: typeof fetch
  providerLabel: string
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const response = await fetchFn(params.endpoint, {
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify(params.request),
    signal: params.signal,
  })
  if (!response.ok) {
    throw new Error(
      `${params.providerLabel} request failed (${response.status})`,
    )
  }
  return parseResponsesSSE(response)
}

export function createOpenAIResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  apiKey?: string
  baseUrl?: string
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const apiKey = params.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OpenAI Responses API key is not configured')
  return requestResponsesStream({
    endpoint: normalizeResponsesEndpoint(
      params.baseUrl ?? process.env.OPENAI_BASE_URL,
    ),
    request: params.request,
    signal: params.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    fetchOverride: params.fetchOverride,
    providerLabel: 'OpenAI Responses API',
  })
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
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId
  return requestResponsesStream({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    request: params.request,
    signal: params.signal,
    headers,
    fetchOverride: params.fetchOverride,
    providerLabel: 'ChatGPT Responses API',
  })
}
