import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  buildLocalChatCurrentMessage,
  buildLocalChatPrompt,
  buildLocalChatMessageContent,
  chatRuntimeSessionId,
  LocalChatSession,
  type LocalChatRuntimeRunner,
} from './chat-session'
import type { LocalCliAgentQueryOptions } from './query-options'

class FakeRunner implements LocalChatRuntimeRunner {
  readonly inputs: LocalCliAgentQueryOptions[] = []
  readonly aborted: string[] = []

  constructor(private readonly turns: SDKMessage[][]) {}

  async *query(input: LocalCliAgentQueryOptions): AsyncGenerator<SDKMessage> {
    this.inputs.push(input)
    for (const message of this.turns.shift() ?? []) yield message
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId)
  }
}

function options(prompt: string): LocalCliAgentQueryOptions {
  return {
    sessionId: 'placeholder',
    prompt,
    cwd: '/tmp/proma-chat-test',
    model: 'model-a',
  }
}

describe('Local Chat Session', () => {
  test('Given 全局自定义指令发生变化 When 构造下一轮 Chat 输入 Then 本轮立即携带最新指令', () => {
    expect(buildLocalChatCurrentMessage('继续处理', '  优先给出可验证结果  ')).toBe([
      '<global_custom_instructions>',
      '优先给出可验证结果',
      '</global_custom_instructions>',
      '<current_user_message>',
      '继续处理',
      '</current_user_message>',
    ].join('\n'))
    expect(buildLocalChatCurrentMessage('继续处理', '   ')).toBe('继续处理')
  })

  test('Given Chat 图片附件 When 构造 CLI 消息 Then 保留真实 base64 image block', () => {
    expect(buildLocalChatMessageContent('看看图片', [{
      mediaType: 'image/png',
      data: 'aGVsbG8=',
    }])).toEqual([
      { type: 'text', text: '看看图片' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    ])
  })

  test('Given CLI 流式快照与工具消息 When 执行 Then 按原顺序投影增量且最终消息不重复', async () => {
    const runner = new FakeRunner([[
      {
        type: 'assistant',
        message: { id: 'message-1', content: [{ type: 'thinking', thinking: '思' }], model: 'model-a' },
        parent_tool_use_id: null,
        _partial: true,
        _partialBlockIndex: 0,
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: { id: 'message-1', content: [{ type: 'thinking', thinking: '思考' }], model: 'model-a' },
        parent_tool_use_id: null,
        _partial: true,
        _partialBlockIndex: 0,
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: { id: 'message-1', content: [{ type: 'text', text: '你' }], model: 'model-a' },
        parent_tool_use_id: null,
        _partial: true,
        _partialBlockIndex: 1,
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: { id: 'message-1', content: [{ type: 'text', text: '你好' }], model: 'model-a' },
        parent_tool_use_id: null,
        _partial: true,
        _partialBlockIndex: 1,
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: {
          id: 'message-1',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__web_search__WebSearch', input: { query: 'Proma' } }],
          model: 'model-a',
        },
        parent_tool_use_id: null,
        _partial: true,
        _partialBlockIndex: 2,
      } as unknown as SDKMessage,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '结果' }] },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        message: {
          id: 'message-1',
          content: [
            { type: 'thinking', thinking: '思考' },
            { type: 'text', text: '你好' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__web_search__WebSearch', input: { query: 'Proma' } },
          ],
          model: 'model-a',
        },
        parent_tool_use_id: null,
        _partialBlockIndexes: [0, 1, 2],
      } as unknown as SDKMessage,
      {
        type: 'result', subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]])
    const session = new LocalChatSession(runner)
    const events: string[] = []

    const result = await session.run({
      conversationId: 'conversation-1',
      history: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }],
      options: options('新问题'),
      onEvent: (event) => {
        if (event.type === 'tool_activity') events.push(`${event.type}:${event.activity?.type}`)
        else events.push(`${event.type}:${event.delta}`)
      },
    })

    expect(events).toEqual([
      'reasoning:思',
      'reasoning:考',
      'text:你',
      'text:好',
      'tool_activity:start',
      'tool_activity:result',
    ])
    expect(result.content).toBe('你好')
    expect(result.reasoning).toBe('思考')
    expect(result.toolActivities).toEqual([
      { type: 'start', toolCallId: 'tool-1', toolName: 'web_search', input: { query: 'Proma' } },
      {
        type: 'result', toolCallId: 'tool-1', toolName: 'web_search',
        input: { query: 'Proma' }, result: '结果', isError: false,
      },
    ])
    expect(runner.inputs[0]?.sessionId).toBe(chatRuntimeSessionId('conversation-1'))
    expect(runner.inputs[0]?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(runner.inputs[0]?.prompt).toContain('<conversation_history>')
    expect(runner.inputs[0]?.prompt).toContain('新问题')
  })

  test('Given 同一 Chat 会话已建立 When 继续追问 Then 不重复注入 JSONL 历史', async () => {
    const success: SDKMessage = {
      type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 },
    }
    const runner = new FakeRunner([[success], [success]])
    const session = new LocalChatSession(runner)
    const shared = {
      conversationId: 'conversation-2',
      history: [{ role: 'user' as const, content: '历史' }],
      onEvent: (): void => {},
    }
    await session.run({
      ...shared,
      options: {
        ...options('第一轮'),
        messageContent: [
          { type: 'text', text: '第一轮' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    })
    await session.run({ ...shared, options: options('第二轮') })

    expect(runner.inputs[0]?.prompt).toBe(buildLocalChatPrompt(shared.history, '第一轮'))
    expect(runner.inputs[0]?.messageContent).toEqual([
      { type: 'text', text: buildLocalChatPrompt(shared.history, '第一轮') },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ])
    expect(runner.inputs[1]?.prompt).toBe('第二轮')
  })

  test('Given 应用重启且元数据已有原生会话 When Chat 继续发送 Then 真实 resume 且不重复注入历史', async () => {
    const runtimeSessionId = chatRuntimeSessionId('conversation-restart')
    const runner = new FakeRunner([[
      {
        type: 'result',
        subtype: 'success',
        session_id: runtimeSessionId,
        usage: { input_tokens: 12, output_tokens: 3 },
      } as SDKMessage,
    ]])
    const restartedSession = new LocalChatSession(runner)

    await restartedSession.run({
      conversationId: 'conversation-restart',
      resumeSessionId: runtimeSessionId,
      history: [{ role: 'user', content: '不应再次注入的旧问题' }],
      options: options('重启后的新问题'),
      onEvent: (): void => {},
    })

    expect(runner.inputs[0]?.resumeSessionId).toBe(runtimeSessionId)
    expect(runner.inputs[0]?.prompt).toBe('重启后的新问题')
  })

  test('Given CLI result 携带累计用量 When Chat 完成 Then 保留原生会话、代次和逐模型快照', async () => {
    const runtimeSessionId = chatRuntimeSessionId('conversation-usage')
    const runner = new FakeRunner([[
      {
        type: 'result',
        subtype: 'success',
        session_id: runtimeSessionId,
        _runtimeRunId: 'usage-event-1',
        _runtimeGeneration: 'generation-2',
        _createdAt: 1234,
        duration_ms: 45,
        num_turns: 2,
        usage: { input_tokens: 20, output_tokens: 5 },
        modelUsage: {
          'model-a': { input_tokens: 20, output_tokens: 5 },
        },
      } as unknown as SDKMessage,
    ]])
    const result = await new LocalChatSession(runner).run({
      conversationId: 'conversation-usage',
      history: [],
      options: options('统计'),
      onEvent: (): void => {},
    })

    expect(result.runtimeSessionId).toBe(runtimeSessionId)
    expect(result.runtimeUsage).toEqual({
      nativeSessionId: runtimeSessionId,
      processGeneration: 'generation-2',
      eventId: 'usage-event-1',
      createdAt: 1234,
      durationMs: 45,
      modelCalls: 2,
      usage: { input_tokens: 20, output_tokens: 5 },
      modelUsage: { 'model-a': { input_tokens: 20, output_tokens: 5 } },
    })
  })

  test('Given 活跃 Chat 会话 When 用户停止 Then 中止带 Chat 命名空间的 Local Service Session', async () => {
    const runner = new FakeRunner([])
    const session = new LocalChatSession(runner)
    await session.stop('conversation-3')
    expect(runner.aborted).toEqual([chatRuntimeSessionId('conversation-3')])
  })

  test('Given Chat 与 Agent 使用同一外部 UUID When 派生 CLI Session Then 稳定且不与 Agent UUID 冲突', () => {
    const conversationId = 'eefce9f8-b03a-4db6-963f-324742d62ccd'
    const first = chatRuntimeSessionId(conversationId)
    expect(first).toBe(chatRuntimeSessionId(conversationId))
    expect(first).not.toBe(conversationId)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
  })
})
