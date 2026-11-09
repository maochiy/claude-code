import { afterEach, expect, mock, spyOn, test } from 'bun:test'

const routeSecret = 'gateway-fixture-key'
process.env.CLAUDE_CODE_OPENAI_RESPONSES_ROUTES = JSON.stringify({
  'glm-native': {
    transport: 'gateway',
    url: 'http://127.0.0.1:39123/v1/responses',
    apiKey: routeSecret,
  },
  'gpt-native': { transport: 'chatgpt' },
})
let authCalls = 0
mock.module('src/services/api/openai/chatgptAuth.ts', () => ({
  getValidChatGPTAuth: async () => {
    authCalls++
    return { accessToken: 'local-fixture' }
  },
}))
const {
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createGatewayResponsesStream,
  getConfiguredResponsesRoute,
  parseResponsesRoutes,
  resolveConfiguredResponsesModel,
  adaptResponsesStreamToAnthropic,
} = await import('../responsesAdapter.js')

test('routes match native model IDs exactly and consume configuration', () => {
  expect(process.env.CLAUDE_CODE_OPENAI_RESPONSES_ROUTES).toBeUndefined()
  expect(getConfiguredResponsesRoute('glm-native')).toEqual({
    transport: 'gateway',
    url: 'http://127.0.0.1:39123/v1/responses',
    apiKey: routeSecret,
  })
  expect(getConfiguredResponsesRoute('gpt-native')).toEqual({
    transport: 'chatgpt',
  })
  expect(getConfiguredResponsesRoute('glm-native-extra')).toBeUndefined()
})

test('native child model bypasses the global OPENAI_MODEL fallback', () => {
  const previous = process.env.OPENAI_MODEL
  process.env.OPENAI_MODEL = 'parent-model'
  try {
    const fallback = () => process.env.OPENAI_MODEL ?? 'missing'
    expect(resolveConfiguredResponsesModel('glm-native', fallback)).toBe(
      'glm-native',
    )
    expect(resolveConfiguredResponsesModel('other-native', fallback)).toBe(
      'parent-model',
    )
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = previous
  }
})

test('gateway URL is restricted to the exact loopback Responses endpoint', () => {
  for (const url of [
    'https://example.com/v1/responses',
    'http://localhost:39123/v1/responses',
    'http://127.0.0.2:39123/v1/responses',
    'http://127.0.0.1:39123/v1/responses?next=1',
    'http://user@127.0.0.1:39123/v1/responses',
    'http://127.0.0.1:39123/other',
  ]) {
    const caught = (() => {
      try {
        parseResponsesRoutes(
          JSON.stringify({
            model: { transport: 'gateway', url, apiKey: routeSecret },
          }),
        )
      } catch (error) {
        return error as Error
      }
    })()
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain(routeSecret)
  }
})

test('gateway stream uses only route bearer and parses Responses SSE', async () => {
  const route = getConfiguredResponsesRoute('glm-native')
  if (!route || route.transport !== 'gateway') throw new Error('missing route')
  const beforeAuth = authCalls
  let seen = false
  const stream = await createGatewayResponsesStream({
    route,
    request: buildResponsesRequest({
      model: 'glm-native',
      messages: [],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: 'fixture',
    }),
    signal: new AbortController().signal,
    fetchOverride: (async (url, init) => {
      seen = true
      expect(url).toBe(route.url)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${routeSecret}`)
      expect(headers.get('ChatGPT-Account-Id')).toBeNull()
      expect(headers.get('Origin')).toBeNull()
      expect(headers.get('Referer')).toBeNull()
      expect(headers.get('OpenAI-Beta')).toBeNull()
      expect(JSON.parse(String(init?.body)).model).toBe('glm-native')
      return new Response(
        `data: ${JSON.stringify({ type: 'response.created' })}\r\n\r\n${frame({ type: 'response.completed', response: {} })}`,
      )
    }) as typeof fetch,
  })
  const events = []
  for await (const event of stream) events.push(event)
  expect(seen).toBe(true)
  expect(authCalls).toBe(beforeAuth)
  expect(events.map(event => event.type)).toEqual([
    'response.created',
    'response.completed',
  ])
})

const request = buildResponsesRequest({
  model: 'fixture',
  messages: [],
  tools: [],
  toolChoice: undefined,
  promptCacheKey: 'fixture',
})
const terminal = { type: 'response.completed', response: {} }
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const reset = () =>
  Object.assign(
    new Error('aborted', {
      cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    }),
    { name: 'AbortError' },
  )
const delays: number[] = []
const originalTimeout = globalThis.setTimeout
function fastBackoff(onDelay?: () => void) {
  return spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    delays.push(ms ?? 0)
    onDelay?.()
    return originalTimeout(fn, 0, ...args)
  }) as typeof setTimeout)
}
afterEach(() => {
  mock.restore()
  delays.length = 0
})

function fixture(
  steps: Array<Response | Error>,
  signal = new AbortController().signal,
) {
  let calls = 0
  const fetchOverride = (async () => {
    const step = steps[calls++]
    if (!step) throw new Error('Unexpected fixture fetch')
    if (step instanceof Error) throw step
    return step
  }) as unknown as typeof fetch
  return {
    calls: () => calls,
    async collect() {
      const result = []
      for await (const event of await createChatGPTResponsesStream({
        request,
        signal,
        fetchOverride,
      }))
        result.push(event)
      return result
    },
  }
}
const ok = () => new Response(frame(terminal))

for (const failure of [
  new Response('private upstream detail', { status: 503 }),
  reset(),
  new TypeError('fetch failed'),
]) {
  test(`retries before delivery: ${failure instanceof Response ? failure.status : failure.message}`, async () => {
    fastBackoff()
    const f = fixture([failure, ok()])
    expect(await f.collect()).toEqual([terminal])
    expect(f.calls()).toBe(2)
    expect(delays).toEqual([1000])
  })
}

test('exhaustion preserves nested code and cause, with 1s/2s backoff', async () => {
  fastBackoff()
  const error = reset()
  const f = fixture([error, error, error])
  const caught = await f.collect().catch(e => e)
  expect(caught.message).toContain('exhausted after 3 attempts')
  expect(caught.message).toContain('ECONNRESET')
  expect(caught.code).toBe('ECONNRESET')
  expect(caught.cause).toBe(error)
  expect(delays).toEqual([1000, 2000])
})

for (const status of [400, 401]) {
  test(`does not retry HTTP ${status}`, async () => {
    const f = fixture([new Response('secret', { status })])
    const caught = await f.collect().catch(e => e)
    expect(caught.status).toBe(status)
    expect(caught.message).not.toContain('secret')
    expect(f.calls()).toBe(1)
  })
}

test('explicit abort and genuine AbortError are never retried', async () => {
  const controller = new AbortController()
  controller.abort()
  const f = fixture([ok()], controller.signal)
  await expect(f.collect()).rejects.toThrow()
  expect(f.calls()).toBe(0)
  const aborted = new DOMException('cancelled', 'AbortError')
  const g = fixture([aborted])
  expect(await g.collect().catch(e => e)).toBe(aborted)
  expect(g.calls()).toBe(1)
})

test('cancellation during real backoff stops immediately', async () => {
  const controller = new AbortController()
  // Abort after the backoff timer has been registered; do not wait 1 second.
  fastBackoff(() => {
    queueMicrotask(() => controller.abort())
  })
  const f = fixture(
    [new Response('', { status: 503 }), ok()],
    controller.signal,
  )
  await expect(f.collect()).rejects.toThrow()
  expect(f.calls()).toBe(1)
})

for (const failRead of [false, true]) {
  test(`no replay after first event on ${failRead ? 'ECONNRESET' : 'EOF'}`, async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (reads++ === 0)
          c.enqueue(
            new TextEncoder().encode(frame({ type: 'response.created' })),
          )
        else if (failRead) c.error(reset())
        else c.close()
      },
    })
    const f = fixture([new Response(body), ok()])
    const caught = await f.collect().catch(e => e)
    expect(caught.message).toContain('not replayed')
    expect(caught.message).toContain(
      failRead ? 'ECONNRESET' : 'CHATGPT_STREAM_INTERRUPTED',
    )
    expect(f.calls()).toBe(1)
    expect(body.locked).toBe(false)
  })
}

test('reader ECONNRESET before the first event can retry', async () => {
  fastBackoff()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(reset())
    },
  })
  const f = fixture([new Response(body), ok()])
  expect(await f.collect()).toEqual([terminal])
  expect(f.calls()).toBe(2)
  expect(body.locked).toBe(false)
})

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} exhaustion preserves status without upstream body`, async () => {
    fastBackoff()
    const f = fixture(
      Array.from({ length: 3 }, () => new Response('secret', { status })),
    )
    const caught = await f.collect().catch(e => e)
    expect(caught.status).toBe(status)
    expect(caught.message).toContain(`HTTP ${status}`)
    expect(caught.message).toContain('exhausted after 3 attempts')
    expect(caught.message).not.toContain('secret')
    expect(f.calls()).toBe(3)
  })
}

test('empty streams retry and then explicitly fail', async () => {
  fastBackoff()
  const f = fixture([new Response(''), new Response(''), new Response(null)])
  await expect(f.collect()).rejects.toThrow('CHATGPT_STREAM_INTERRUPTED')
  expect(f.calls()).toBe(3)
})

test('CRLF split across chunks, UTF-8 and EOF tail frames are decoded', async () => {
  const bytes = new TextEncoder().encode(
    `data: {"type":"response.created","text":"你好"}\r\n\r\ndata: ${JSON.stringify(terminal)}`,
  )
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte))
      c.close()
    },
  })
  const f = fixture([new Response(body)])
  expect(await f.collect()).toEqual([
    { type: 'response.created', text: '你好' },
    terminal,
  ])
  expect(body.locked).toBe(false)
})

for (const type of [
  'response.completed',
  'response.incomplete',
  'response.failed',
  'response.error',
  'error',
]) {
  test(`terminal ${type} finishes without replay`, async () => {
    let cancelled = false
    const event = {
      type,
      response: {
        error: { message: 'business failure', code: 'invalid_request' },
      },
      error: { message: 'business failure', code: 'invalid_request' },
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame(event)))
      },
      cancel() {
        cancelled = true
      },
    })
    const f = fixture([new Response(body)])
    const events = await f.collect()
    expect(events).toEqual([event])
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(f.calls()).toBe(1)
    if (['response.failed', 'response.error', 'error'].includes(type)) {
      const consume = async () => {
        for await (const _ of adaptResponsesStreamToAnthropic(
          (async function* () {
            yield event
          })(),
          'fixture',
        )) {
          /* drain */
        }
      }
      expect((await consume().catch(e => e)).code).toBe('invalid_request')
    }
  })
}

test('malformed SSE never exposes payload through messages or causes', async () => {
  const marker = 'SECRET_UPSTREAM_TOKEN'
  const f = fixture([new Response(`data: ${marker}\n\n`)])
  const caught = await f.collect().catch(e => e)
  expect(caught).toBeInstanceOf(Error)
  expect(caught.code).toBe('CHATGPT_INVALID_SSE')
  expect(caught.message).toContain('CHATGPT_INVALID_SSE')
  let current: unknown = caught
  let depth = 0
  while (current instanceof Error) {
    expect(current.message).not.toContain(marker)
    expect(current.stack).not.toContain(marker)
    current = current.cause
    depth++
  }
  expect(current).toBeUndefined()
  expect(depth).toBe(2)
  expect(f.calls()).toBe(1)
})

for (const status of [200, 503]) {
  test(`pending cancel does not block HTTP ${status} completion or retry`, async () => {
    if (status === 503) fastBackoff()
    let cancelled = false
    let pendingReads = 0
    let settledReads = 0
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        if (status === 200) c.enqueue(new TextEncoder().encode(frame(terminal)))
      },
      cancel() {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const originalGetReader = body.getReader.bind(body)
    spyOn(body, 'getReader').mockImplementation(() => {
      const reader = originalGetReader()
      const originalRead = reader.read.bind(reader)
      spyOn(reader, 'read').mockImplementation(async () => {
        pendingReads++
        try {
          const result = await originalRead()
          return result.done
            ? { done: true as const, value: undefined }
            : { done: false as const, value: result.value }
        } finally {
          pendingReads--
          settledReads++
        }
      })
      const originalRelease = reader.releaseLock.bind(reader)
      spyOn(reader, 'releaseLock').mockImplementation(() => {
        expect(pendingReads).toBe(0)
        expect(settledReads).toBeGreaterThan(0)
        originalRelease()
      })
      return reader
    })
    const f = fixture([
      new Response(body, { status }),
      ...(status === 503 ? [ok()] : []),
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const events = await Promise.race([
        f.collect(),
        new Promise<never>((_, reject) => {
          timer = originalTimeout(
            () => reject(new Error('cancel blocked transport')),
            500,
          )
        }),
      ])
      expect(events).toEqual([terminal])
    } finally {
      clearTimeout(timer)
    }
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(pendingReads).toBe(0)
    expect(f.calls()).toBe(status === 503 ? 2 : 1)
    if (status === 200) expect(settledReads).toBe(1)
  })
}

test('consumer return and invalid JSON cancel and release the reader', async () => {
  for (const malformed of [false, true]) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            malformed ? 'data: {bad}\n\n' : frame({ type: 'response.created' }),
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const stream = await createChatGPTResponsesStream({
      request,
      signal: new AbortController().signal,
      fetchOverride: (async () =>
        new Response(body)) as unknown as typeof fetch,
    })
    const consume = async () => {
      for await (const _ of stream) break
    }
    if (malformed) await expect(consume()).rejects.toThrow()
    else await consume()
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  }
})
