import { describe, expect, test } from 'bun:test'
import { normalizeDiscreteUsageSnapshots, normalizeUsageSnapshots, UserUsageLedger } from './user-usage-ledger'

function snapshot(overrides: Partial<Parameters<UserUsageLedger['apply']>[0]> = {}) {
  return {
    sessionId: 'session-a',
    nativeSessionId: 'native-a',
    processGeneration: 'process-1',
    eventId: 'result-1',
    createdAt: 1_000,
    durationMs: 100,
    fastMode: false,
    modelCalls: 1,
    usage: { inputTokens: 100, outputTokens: 10 },
    models: { modelA: { inputTokens: 100, outputTokens: 10 } },
    ...overrides,
  }
}

describe('UserUsageLedger', () => {
  test('Given 同一 Session 连续两轮累计快照 When 归一化 Then 第二轮只记录增长量', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot(),
      snapshot({
        eventId: 'result-2',
        createdAt: 2_000,
        usage: { inputTokens: 160, outputTokens: 25 },
        models: { modelA: { inputTokens: 160, outputTokens: 25 } },
      }),
    ])

    expect(deltas.map((item) => item.usage)).toEqual([
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { inputTokens: 60, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ])
  })

  test('Given 多模型累计快照 When 第二轮只有一个模型增长 Then 不把未增长模型重复计量', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot({
        models: {
          modelA: { inputTokens: 80, outputTokens: 8 },
          modelB: { inputTokens: 20, outputTokens: 2 },
        },
      }),
      snapshot({
        eventId: 'result-2',
        usage: { inputTokens: 125, outputTokens: 15 },
        models: {
          modelA: { inputTokens: 80, outputTokens: 8 },
          modelB: { inputTokens: 45, outputTokens: 7 },
        },
      }),
    ])

    expect(deltas[1]?.models).toEqual([{
      modelId: 'modelB',
      inputTokens: 25,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }])
    expect(deltas[1]?.usage).toEqual({
      inputTokens: 25,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  test('Given 相同 result 在恢复时重放 When 归一化 Then 事件 ID 去重且总量不翻倍', () => {
    const ledger = new UserUsageLedger()
    const first = ledger.apply(snapshot())
    const duplicate = ledger.apply(snapshot())

    expect(first?.usage.inputTokens).toBe(100)
    expect(duplicate).toBeNull()
  })

  test('Given 父子 Agent 以不同事件 ID 重放相同累计快照 When 归一化 Then 不新增零用量轮次', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot({ eventId: 'parent-result', modelCalls: 2 }),
      snapshot({ eventId: 'child-result', modelCalls: 1 }),
    ])

    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.eventId).toBe('parent-result')
    expect(deltas[0]?.modelCalls).toBe(2)
  })

  test('Given 新进程恢复后用新事件 ID 重放基线 When 归一化 Then 基线不计为新轮次', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot({ eventId: 'before-restart' }),
      snapshot({ eventId: 'resume-baseline', processGeneration: 'process-2' }),
      snapshot({
        eventId: 'after-resume',
        processGeneration: 'process-2',
        usage: { inputTokens: 125, outputTokens: 14 },
        models: { modelA: { inputTokens: 125, outputTokens: 14 } },
      }),
    ])

    expect(deltas).toHaveLength(2)
    expect(deltas[1]?.usage).toEqual({
      inputTokens: 25,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  test('Given 应用重启后新进程恢复累计基线 When 首个 result 到达 Then 只记录恢复后的增长', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot(),
      snapshot({
        processGeneration: 'process-2',
        eventId: 'result-2',
        usage: { inputTokens: 135, outputTokens: 16 },
        models: { modelA: { inputTokens: 135, outputTokens: 16 } },
      }),
    ])

    expect(deltas[1]?.usage).toEqual({
      inputTokens: 35,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  test('Given 新进程没有恢复旧累计器 When 计数回退 Then 将当前快照作为新代次增量', () => {
    const deltas = normalizeUsageSnapshots([
      snapshot({ usage: { inputTokens: 100, outputTokens: 10 }, models: { modelA: { inputTokens: 100, outputTokens: 10 } } }),
      snapshot({
        processGeneration: 'process-2',
        eventId: 'result-2',
        usage: { inputTokens: 20, outputTokens: 3 },
        models: { modelA: { inputTokens: 20, outputTokens: 3 } },
      }),
    ])

    expect(deltas[1]?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    expect(deltas[1]?.processGeneration).toEndWith(':1')
  })

  test('Given Auto classifier 终态在 JSONL 重放 When 按 call_id 记录 Then 原始两阶段合计只计一次', () => {
    const classifier = {
      sessionId: 'session-a',
      callId: 'classifier-call-1',
      createdAt: 3_000,
      durationMs: 80,
      source: 'auto' as const,
      modelId: 'classifier-small',
      usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 6 },
    }
    const deltas = normalizeDiscreteUsageSnapshots([classifier, classifier])

    expect(deltas).toEqual([{
      sessionId: 'session-a',
      callId: 'classifier-call-1',
      createdAt: 3_000,
      durationMs: 80,
      source: 'auto',
      turns: 0,
      modelCalls: 1,
      usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 6, cacheCreationTokens: 0 },
      models: [{
        modelId: 'classifier-small',
        inputTokens: 30,
        outputTokens: 4,
        cacheReadTokens: 6,
        cacheCreationTokens: 0,
      }],
    }])
  })
})
