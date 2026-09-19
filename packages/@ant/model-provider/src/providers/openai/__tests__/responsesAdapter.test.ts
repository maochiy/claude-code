import { describe, expect, test } from 'bun:test'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  extractUsage,
  parseResponsesSSE,
} from '../responsesAdapter.js'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('OpenAI Responses request conversion', () => {
  test('preserves multimodal input, function calls and tool results', () => {
    const request = buildResponsesRequest({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA' },
            },
          ],
        },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Lookup',
            parameters: { type: 'object' },
          },
        },
      ],
      toolChoice: 'auto',
      reasoningEffort: 'high',
    })

    expect(request.instructions).toBe('system')
    expect(request.input).toContainEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    })
    expect(request.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    })
    expect(request.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'done',
    })
    expect(request.reasoning).toEqual({ effort: 'high' })
    expect(request.prompt_cache_key).toBeUndefined()
  })
})

describe('OpenAI Responses SSE projection', () => {
  test('projects thinking, text, tool calls and terminal usage', async () => {
    async function* fixture(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'response.reasoning_summary_text.delta', delta: 'plan' }
      yield { type: 'response.output_text.delta', delta: 'answer' }
      yield {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', call_id: 'call_2', name: 'lookup' },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 2,
        delta: '{"q":"y"}',
      }
      yield { type: 'response.output_item.done', output_index: 2 }
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
          },
        },
      }
    }

    const events = await collect(
      adaptResponsesStreamToAnthropic(fixture(), 'gpt-test'),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'plan' },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'answer' },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'call_2',
          name: 'lookup',
          input: {},
        },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"q":"y"}' },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message_delta',
        usage: {
          input_tokens: 5,
          output_tokens: 4,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 5,
        },
      }),
    )
    expect(events.at(-1)).toEqual({ type: 'message_stop' })
  })

  test('parses CRLF and a final SSE frame without a trailing blank line', async () => {
    const body = ['data: {"type":"one"}\r\n\r\n', 'data: {"type":"two"}']
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of body)
            controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
    )
    expect(await collect(parseResponsesSSE(response))).toEqual([
      { type: 'one' },
      { type: 'two' },
    ])
  })
})

describe('OpenAI Responses usage', () => {
  test('keeps cache segments mutually exclusive', () => {
    expect(
      extractUsage({
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
        },
      }),
    ).toEqual({
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 6,
    })
  })
})
