import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOpenAIResponsesStream,
} from '../responsesAdapter.js'

const saved = {
  access: process.env.OPENAI_CHATGPT_ACCESS_TOKEN,
  account: process.env.OPENAI_CHATGPT_ACCOUNT_ID,
}

afterEach(() => {
  if (saved.access === undefined) delete process.env.OPENAI_CHATGPT_ACCESS_TOKEN
  else process.env.OPENAI_CHATGPT_ACCESS_TOKEN = saved.access
  if (saved.account === undefined) delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
  else process.env.OPENAI_CHATGPT_ACCOUNT_ID = saved.account
})

function request() {
  return buildResponsesRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    toolChoice: undefined,
  })
}

function emptySSE(): Response {
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('Responses transports', () => {
  test('uses the explicit API endpoint and keeps the API key out of the body', async () => {
    let capturedUrl = ''
    let captured: RequestInit | undefined
    await createOpenAIResponsesStream({
      request: request(),
      signal: new AbortController().signal,
      apiKey: 'fixture-api-key',
      baseUrl: 'https://gateway.example.test/v1/responses',
      fetchOverride: (async (input, init) => {
        capturedUrl = String(input)
        captured = init
        return emptySSE()
      }) as typeof fetch,
    })
    expect(capturedUrl).toBe('https://gateway.example.test/v1/responses')
    expect((captured?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-api-key',
    )
    expect(String(captured?.body)).not.toContain('fixture-api-key')
  })

  test('passes cancellation to the Responses request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createOpenAIResponsesStream({
        request: request(),
        signal: controller.signal,
        apiKey: 'fixture-api-key',
        fetchOverride: (async (_input, init) => {
          if (init?.signal?.aborted)
            throw new DOMException('aborted', 'AbortError')
          return emptySSE()
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('uses host OAuth access and account headers without reading user credentials', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'fixture-oauth-access'
    process.env.OPENAI_CHATGPT_ACCOUNT_ID = 'fixture-account'
    let captured: RequestInit | undefined
    await createChatGPTResponsesStream({
      request: request(),
      signal: new AbortController().signal,
      fetchOverride: (async (_input, init) => {
        captured = init
        return emptySSE()
      }) as typeof fetch,
    })
    const headers = captured?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fixture-oauth-access')
    expect(headers['ChatGPT-Account-Id']).toBe('fixture-account')
    expect(String(captured?.body)).not.toContain('fixture-oauth-access')
  })
})
