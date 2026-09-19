import { describe, expect, test } from 'bun:test'
import {
  aggregateUserUsage,
  computeStreaks,
  isUsageRelatedLine,
  localDayKey,
  parseUsageRecords,
  selectSessionQueries,
  sumUsageTokens,
} from './user-usage-aggregator'

function dayDate(day: string, hour = 12): Date {
  const parts = day.split('-').map(Number)
  const year = parts[0] ?? 0
  const month = parts[1] ?? 1
  const date = parts[2] ?? 1
  return new Date(year, month - 1, date, hour)
}

describe('user-usage-aggregator', () => {
  test('given SDK result usage when 汇总 then 按 result 累计真实 Token 且按模型拆分', () => {
    const lines = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 12_000,
        fast_mode_state: 'off',
        _createdAt: dayDate('2026-06-30').getTime(),
        _channelModelId: 'grok-4.5',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
        modelUsage: {
          'grok-4.5': {
            inputTokens: 80,
            outputTokens: 15,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
          },
          'deepseek-v4-flash': {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        _createdAt: dayDate('2026-06-30').getTime(),
        message: {
          model: 'grok-4.5',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'brainstorming' } }],
        },
      }),
    ]

    const records = parseUsageRecords(lines, 'session-a')
    const queries = selectSessionQueries(records)
    const summary = aggregateUserUsage({
      queries,
      skillUses: records.skillUses,
      sessions: [{ id: 'session-a', createdAt: dayDate('2026-06-30').getTime(), updatedAt: dayDate('2026-06-30', 13).getTime() }],
      chatCount: 2,
      now: dayDate('2026-06-30'),
      resolveModelName: (id) => id === 'grok-4.5' ? 'Grok 4.5' : id,
    })

    expect(queries).toHaveLength(1)
    expect(summary.stats.totalTokens).toBe(170)
    expect(summary.stats.requests).toBe(1)
    expect(summary.stats.peakDayTokens).toBe(170)
    expect(summary.stats.peakDay).toBe('2026-06-30')
    expect(summary.stats.skillsExplored).toBe(1)
    expect(summary.stats.skillUses).toBe(1)
    expect(summary.models.map((item) => item.modelId)).toEqual(['grok-4.5', 'deepseek-v4-flash'])
    expect(summary.models[0]?.modelName).toBe('Grok 4.5')
    expect(summary.models[0]?.requests).toBe(1)
  })

  test('given 合成压缩 result when 解析 then 忽略该条用量', () => {
    const lines = [
      JSON.stringify({
        type: 'result',
        isSyntheticCompactionResult: true,
        _createdAt: dayDate('2026-06-30').getTime(),
        usage: { input_tokens: 999, output_tokens: 1 },
      }),
    ]
    const records = parseUsageRecords(lines, 'session-a')
    expect(selectSessionQueries(records)).toHaveLength(0)
  })

  test('given 压缩前后真实 result 保持累计且中间有合成 result when 汇总 then 累计不减少也不重复', () => {
    const result = (uuid: string, inputTokens: number) => JSON.stringify({
      type: 'result',
      subtype: 'success',
      uuid,
      session_id: 'native-session',
      processGeneration: 'process-1',
      usage: { input_tokens: inputTokens, output_tokens: 10 },
      modelUsage: { modelA: { input_tokens: inputTokens, output_tokens: 10 } },
    })
    const records = parseUsageRecords([
      result('before-compact', 100),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        uuid: 'synthetic-compact',
        isSyntheticCompactionResult: true,
        usage: { input_tokens: 40, output_tokens: 0 },
      }),
      result('after-compact', 140),
    ], 'session-compact')
    const queries = selectSessionQueries(records)

    expect(queries).toHaveLength(2)
    expect(queries.map((query) => query.inputTokens)).toEqual([100, 40])
    expect(queries.reduce((sum, query) => sum + sumUsageTokens(query), 0)).toBe(150)
  })

  test('given 父子 Agent 不同事件 ID 写入相同累计 result when 汇总 then 请求和轮次只计一次', () => {
    const base = {
      type: 'result',
      subtype: 'success',
      session_id: 'native-session',
      processGeneration: 'process-1',
      num_turns: 2,
      usage: { input_tokens: 120, output_tokens: 20 },
      modelUsage: {
        parent: { input_tokens: 90, output_tokens: 15 },
        child: { input_tokens: 30, output_tokens: 5 },
      },
    }
    const records = parseUsageRecords([
      JSON.stringify({ ...base, uuid: 'parent-result' }),
      JSON.stringify({ ...base, uuid: 'child-result' }),
    ], 'session-subagent')
    const queries = selectSessionQueries(records)
    const summary = aggregateUserUsage({
      queries,
      skillUses: [],
      sessions: [],
      chatCount: 0,
      now: new Date(1_000),
    })

    expect(queries).toHaveLength(1)
    expect(summary.stats).toMatchObject({
      totalTokens: 140,
      requests: 1,
      turns: 1,
      modelCalls: 2,
    })
    expect(summary.models.map((model) => [model.modelId, model.tokens])).toEqual([
      ['parent', 105],
      ['child', 35],
    ])
  })

  test('given 旧版 assistant.usage 且没有 result when 汇总 then 回退统计 Token', () => {
    const lines = [
      JSON.stringify({
        role: 'assistant',
        model: 'gpt-5.6-sol',
        createdAt: dayDate('2026-07-01').getTime(),
        durationMs: 8000,
        usage: { inputTokens: 50, outputTokens: 10 },
      }),
    ]
    const records = parseUsageRecords(lines, 'session-b')
    const summary = aggregateUserUsage({
      queries: selectSessionQueries(records),
      skillUses: [],
      sessions: [{ id: 'session-b', createdAt: 1, updatedAt: 2 }],
      chatCount: 0,
      now: dayDate('2026-07-01'),
    })
    expect(summary.stats.totalTokens).toBe(60)
    expect(summary.stats.requests).toBe(1)
    expect(summary.models[0]?.modelId).toBe('gpt-5.6-sol')
  })

  test('given 连续活跃日且今天无用量 when 计算连续天数 then 当前为 0 且最长保留历史', () => {
    const streaks = computeStreaks(
      ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-10'],
      dayDate('2026-06-12'),
    )
    expect(streaks.currentStreakDays).toBe(0)
    expect(streaks.longestStreakDays).toBe(3)
  })

  test('given 今天也有用量 when 计算连续天数 then 从今天往回计', () => {
    const streaks = computeStreaks(
      ['2026-06-28', '2026-06-29', '2026-06-30'],
      dayDate('2026-06-30'),
    )
    expect(streaks.currentStreakDays).toBe(3)
    expect(streaks.longestStreakDays).toBe(3)
  })

  test('given 同一会话多次请求 when 汇总 then 最长聊天时长取活动跨度', () => {
    const start = dayDate('2026-06-30', 8).getTime()
    const end = dayDate('2026-06-30', 19).getTime()
    const summary = aggregateUserUsage({
      queries: [
        {
          sessionId: 'session-a',
          createdAt: start,
          durationMs: 20_000,
          fastMode: false,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          models: [{ modelId: 'grok-4.5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }],
        },
        {
          sessionId: 'session-a',
          createdAt: end,
          durationMs: 30_000,
          fastMode: true,
          inputTokens: 2,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          models: [{ modelId: 'grok-4.5', inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }],
        },
      ],
      skillUses: [],
      sessions: [{ id: 'session-a', createdAt: start, updatedAt: end }],
      chatCount: 0,
      now: dayDate('2026-06-30', 19),
    })
    expect(summary.stats.longestChatDurationMs).toBe(end - start)
    expect(summary.stats.fastModeRate).toBe(0.5)
    expect(localDayKey(start)).toBe('2026-06-30')
    expect(sumUsageTokens({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheCreationTokens: 5 })).toBe(14)
  })

  test('given Cowork 与 Code 请求在同一天 when 汇总 then 日用量按模式拆分且总量一致', () => {
    const createQuery = (mode: 'cowork' | 'code', inputTokens: number) => ({
      sessionId: `${mode}-session`,
      mode,
      createdAt: dayDate('2026-09-17').getTime(),
      durationMs: 1_000,
      fastMode: false,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      models: [{ modelId: 'model', inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    })
    const summary = aggregateUserUsage({
      queries: [createQuery('cowork', 25), createQuery('code', 75)],
      skillUses: [],
      sessions: [],
      chatCount: 1,
      now: dayDate('2026-09-17'),
    })

    expect(summary.days).toEqual([{
      day: '2026-09-17',
      tokens: 100,
      requests: 2,
      coworkTokens: 25,
      codeTokens: 75,
      coworkRequests: 1,
      codeRequests: 1,
      turns: 2,
    }])
  })

  test('given 连续两轮累计 modelUsage 与重复 result when 解析 then 只生成两轮增量并按模型归属', () => {
    const result = (uuid: string, createdAt: number, inputA: number, inputB: number) => JSON.stringify({
      type: 'result',
      subtype: 'success',
      uuid,
      session_id: 'native-session',
      processGeneration: 'process-1',
      _createdAt: createdAt,
      num_turns: 2,
      usage: { input_tokens: inputA + inputB, output_tokens: 10 },
      modelUsage: {
        modelA: { inputTokens: inputA, outputTokens: 6 },
        modelB: { inputTokens: inputB, outputTokens: 4 },
      },
    })
    const lines = [
      JSON.stringify({
        type: 'user', uuid: 'user-1', parent_tool_use_id: null, _createdAt: 900,
        message: { content: [{ type: 'text', text: '第一轮' }] },
      }),
      result('result-1', 1_000, 80, 20),
      JSON.stringify({
        type: 'user', uuid: 'user-2', parent_tool_use_id: null, _createdAt: 1_900,
        message: { content: [{ type: 'text', text: '第二轮' }] },
      }),
      result('result-2', 2_000, 80, 45),
      result('result-2', 2_000, 80, 45),
    ]

    const records = parseUsageRecords(lines, 'session-a')
    const queries = selectSessionQueries(records)
    const summary = aggregateUserUsage({
      queries,
      skillUses: [],
      messageEvents: records.messageEvents,
      sessions: [],
      chatCount: 0,
      now: new Date(2_000),
    })

    expect(queries).toHaveLength(2)
    expect(queries[1]?.inputTokens).toBe(25)
    expect(queries[1]?.models).toEqual([{
      modelId: 'modelB', inputTokens: 25, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }])
    expect(summary.stats.totalTokens).toBe(135)
    expect(summary.stats.userMessages).toBe(2)
    expect(summary.stats.turns).toBe(2)
    expect(summary.stats.modelCalls).toBe(4)
  })

  test('given 合成工具 user 与 compact 控制消息 when 解析 then 不计为真实用户消息', () => {
    const records = parseUsageRecords([
      JSON.stringify({ type: 'user', parent_tool_use_id: 'tool', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '/compact' }] } }),
      JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '真实消息' }] } }),
      JSON.stringify({ type: 'user', uuid: 'duplicate-user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '只计一次' }] } }),
      JSON.stringify({ type: 'user', uuid: 'duplicate-user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '只计一次' }] } }),
      '{"type":"user",broken',
    ], 'session-a')

    expect(records.messageEvents).toHaveLength(2)
    expect(records.invalidLines).toBe(1)
  })

  test('given Chat 重启后持久化累计 runtimeUsage 与重复事件 when 解析 then 仅统计增量且归入 Cowork', () => {
    const chatLine = (
      id: string,
      eventId: string,
      generation: string,
      inputTokens: number,
      outputTokens: number,
    ) => JSON.stringify({
      id,
      role: 'assistant',
      content: '回答',
      createdAt: 2_000,
      model: 'chat-model',
      runtimeUsage: {
        nativeSessionId: 'native-chat-session',
        processGeneration: generation,
        eventId,
        createdAt: 2_000,
        durationMs: 100,
        modelCalls: 1,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        modelUsage: {
          'chat-model': { input_tokens: inputTokens, output_tokens: outputTokens },
        },
      },
    })
    const records = parseUsageRecords([
      JSON.stringify({ id: 'chat-user-1', role: 'user', content: '第一轮', createdAt: 1_000 }),
      chatLine('chat-assistant-1', 'chat-result-1', 'generation-1', 100, 10),
      JSON.stringify({ id: 'chat-user-2', role: 'user', content: '第二轮', createdAt: 1_500 }),
      chatLine('chat-assistant-2', 'chat-result-2', 'generation-2', 130, 15),
      chatLine('chat-assistant-2-duplicate', 'chat-result-2', 'generation-2', 130, 15),
    ], 'chat-conversation', 'cowork')
    const queries = selectSessionQueries(records)

    expect(queries).toHaveLength(2)
    expect(queries.map(query => query.mode)).toEqual(['cowork', 'cowork'])
    expect(queries[0]?.inputTokens).toBe(100)
    expect(queries[1]?.inputTokens).toBe(30)
    expect(queries[1]?.outputTokens).toBe(5)
    expect(records.messageEvents).toHaveLength(2)
  })

  test('given Auto classifier checking、终态与 result when 解析 then 按 call_id 只统计终态独立用量并标记来源', () => {
    const classifier = (status: string, includedInResult: boolean, callId = 'classifier-call-1') => JSON.stringify({
      type: 'system',
      subtype: 'auto_mode_classifier',
      status,
      call_id: callId,
      usage_scope: 'classifier_call',
      usage_included_in_result: includedInResult,
      model: 'classifier-small',
      _createdAt: dayDate('2026-09-18').getTime(),
      duration_ms: 200,
      // 终态 usage 已包含 checking + decision 两阶段，账本不得再做累计差分。
      usage: { total_tokens: 45 },
    })
    const records = parseUsageRecords([
      classifier('checking', false),
      classifier('allowed', false),
      classifier('allowed', false),
      classifier('blocked', true, 'included-by-result'),
      JSON.stringify({
        type: 'result',
        uuid: 'result-1',
        session_id: 'native-session',
        processGeneration: 'process-1',
        _createdAt: dayDate('2026-09-18', 13).getTime(),
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10 },
        modelUsage: { 'main-model': { input_tokens: 100, output_tokens: 10 } },
      }),
    ], 'session-auto')
    expect(isUsageRelatedLine(classifier('allowed', false))).toBe(true)
    const queries = selectSessionQueries(records)
    const summary = aggregateUserUsage({
      queries,
      skillUses: [],
      sessions: [],
      chatCount: 0,
      now: dayDate('2026-09-18'),
    })

    expect(queries).toHaveLength(2)
    expect(queries.find((query) => query.source === 'auto')).toMatchObject({
      inputTokens: 45,
      outputTokens: 0,
      turns: 0,
      modelCalls: 1,
      models: [{ modelId: 'classifier-small', inputTokens: 45, outputTokens: 0 }],
    })
    expect(summary.stats).toMatchObject({
      totalTokens: 155,
      requests: 2,
      turns: 1,
      modelCalls: 2,
      autoTokens: 45,
      autoRequests: 1,
    })
    expect(summary.days[0]).toMatchObject({
      tokens: 155,
      codeTokens: 155,
      autoTokens: 45,
      autoRequests: 1,
    })
    expect(summary.models.find((model) => model.modelId === 'classifier-small')).toMatchObject({
      tokens: 45,
      requests: 1,
      autoTokens: 45,
      autoRequests: 1,
    })
  })
})
