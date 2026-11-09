import { describe, expect, test } from 'bun:test'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  extractUsage,
} from '../responsesAdapter.js'
import { formatOpenAIPromptCacheKey } from '../openaiShared.js'
import { calculateCacheHitRate } from '../../../../utils/cacheWarning.js'

describe('buildResponsesRequest', () => {
  const promptCacheKey = formatOpenAIPromptCacheKey('session-abc-123')

  test('includes max reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'max',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'max' })
  })

  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('does not include unsupported max_output_tokens parameter', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('includes stable prompt_cache_key for session-sticky cache routing', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    })

    expect(request.prompt_cache_key).toBe('ccb:session-abc-123')
  })

  test('prompt_cache_key is stable across turns (not derived from messages)', () => {
    const key = formatOpenAIPromptCacheKey('same-session')
    const turn1 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'first' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })
    const turn2 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })

    expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key)
    expect(turn1.prompt_cache_key).toBe('ccb:same-session')
  })
})

describe('extractUsage (OpenAI Responses → Anthropic usage)', () => {
  test('subtracts cached_tokens so hit rate uses OpenAI total as denominator', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 20_000 },
      },
    })

    expect(usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })

    // Was 40% under the double-count bug; correct is 66.7%.
    const hitRate = calculateCacheHitRate(usage)
    expect(hitRate).toBeCloseTo((20_000 / 30_000) * 100, 5)
  })

  test('full cache hit can report 100% (not capped at 50%)', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30_000 },
      },
    })

    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(30_000)
    expect(calculateCacheHitRate(usage)).toBe(100)
  })

  test('maps cache_write_tokens to cache_creation without double-counting total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 10_000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 6_000,
          cache_write_tokens: 2_000,
        },
      },
    })

    expect(usage).toEqual({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 6_000,
    })
    // segments sum to OpenAI total
    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(10_000)
    expect(calculateCacheHitRate(usage)).toBeCloseTo(60, 5)
  })

  test('clamps overlapping write/read that exceed total input', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 5_000,
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 4_000,
        },
      },
    })

    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(5_000)
    expect(usage.cache_read_input_tokens).toBe(4_000)
    expect(usage.cache_creation_input_tokens).toBe(1_000)
    expect(usage.input_tokens).toBe(0)
  })
})

describe('adaptResponsesStreamToAnthropic function call arguments', () => {
  async function adapt(events: Record<string, unknown>[]) {
    const stream = (async function* () {
      yield* events
    })()
    const result: Record<string, unknown>[] = []
    for await (const event of adaptResponsesStreamToAnthropic(stream, 'test')) {
      result.push(event as unknown as Record<string, unknown>)
    }
    return result
  }

  const added = {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', call_id: 'call_1', name: 'test_tool' },
  }
  const completed = (argumentsValue?: string) => ({
    type: 'response.completed',
    response: {
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'test_tool',
          ...(argumentsValue === undefined
            ? {}
            : { arguments: argumentsValue }),
        },
      ],
    },
  })
  const argumentDeltas = (events: Record<string, unknown>[]) =>
    events
      .filter(event => event.type === 'content_block_delta')
      .map(event => (event.delta as Record<string, unknown>).partial_json)

  test('emits streamed deltas once when all terminal events repeat full arguments', async () => {
    const events = await adapt([
      added,
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"x":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '1}',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        arguments: '{"x":1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', arguments: '{"x":1}' },
      },
      completed('{"x":1}'),
    ])

    expect(argumentDeltas(events)).toEqual(['{"x":', '1}'])
    expect(
      events.filter(event => event.type === 'content_block_stop'),
    ).toHaveLength(1)
  })

  test('completes a streamed prefix using only the missing suffix', async () => {
    const events = await adapt([
      added,
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"x":',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        arguments: '{"x":1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', arguments: '{"x":1}' },
      },
      completed('{"x":1}'),
    ])

    expect(argumentDeltas(events)).toEqual(['{"x":', '1}'])
  })

  test.each([
    [
      'arguments.done',
      [
        {
          type: 'response.function_call_arguments.done',
          output_index: 0,
          arguments: '{"x":1}',
        },
        { type: 'response.output_item.done', output_index: 0 },
      ],
    ],
    [
      'output_item.done',
      [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', arguments: '{"x":1}' },
        },
      ],
    ],
    [
      'response.completed',
      [{ type: 'response.output_item.done', output_index: 0 }],
    ],
  ])('emits full arguments from %s when no deltas arrive', async (_source, terminalEvents) => {
    const events = await adapt([added, ...terminalEvents, completed('{"x":1}')])
    expect(argumentDeltas(events)).toEqual(['{"x":1}'])
    const deltaIndex = events.findIndex(
      event => event.type === 'content_block_delta',
    )
    const stopIndex = events.findIndex(
      event => event.type === 'content_block_stop',
    )
    expect(deltaIndex).toBeLessThan(stopIndex)
  })

  test('does not invent arguments when no event carries them', async () => {
    const events = await adapt([
      added,
      { type: 'response.output_item.done', output_index: 0 },
      completed(),
    ])
    expect(argumentDeltas(events)).toEqual([])
  })

  test('rejects a terminal value that conflicts with streamed arguments', async () => {
    expect(
      adapt([
        added,
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"x":1',
        },
        {
          type: 'response.function_call_arguments.done',
          output_index: 0,
          arguments: '{"y":1}',
        },
      ]),
    ).rejects.toThrow(
      'Responses function call arguments changed after streaming',
    )
  })
})
