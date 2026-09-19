import { describe, expect, test } from 'bun:test'
import type { UserUsageDay } from '../../../../types/user-profile'
import {
  buildUsageDaySeries,
  formatAxisTokens,
  formatCompactTokens,
  summarizeUsageRange,
} from './usage-page-model'

function usageDay(overrides: Partial<UserUsageDay> & Pick<UserUsageDay, 'day'>): UserUsageDay {
  return {
    tokens: 0,
    requests: 0,
    coworkTokens: 0,
    codeTokens: 0,
    coworkRequests: 0,
    codeRequests: 0,
    ...overrides,
  }
}

describe('usage-page-model', () => {
  test('Given 7 天范围内有分类用量 When 构造序列 Then 日期连续、缺失日补零且保留 Cowork/Code 分类', () => {
    const series = buildUsageDaySeries([
      usageDay({ day: '2026-09-15', tokens: 40, coworkTokens: 10, codeTokens: 30 }),
      usageDay({ day: '2026-09-17', tokens: 70, coworkTokens: 20, codeTokens: 50 }),
    ], '7d', new Date(2026, 8, 17, 18))

    expect(series).toHaveLength(7)
    expect(series[0]).toEqual({ day: '2026-09-11', coworkTokens: 0, codeTokens: 0, autoTokens: 0, totalTokens: 0, userMessages: 0, turns: 0, modelCalls: 0 })
    expect(series[4]).toEqual({ day: '2026-09-15', coworkTokens: 10, codeTokens: 30, autoTokens: 0, totalTokens: 40, userMessages: 0, turns: 0, modelCalls: 0 })
    expect(series[6]).toEqual({ day: '2026-09-17', coworkTokens: 20, codeTokens: 50, autoTokens: 0, totalTokens: 70, userMessages: 0, turns: 0, modelCalls: 0 })
  })

  test('Given 旧版日汇总只有总 Token When 构造序列 Then 全部归入 Code 而不虚构 Cowork 用量', () => {
    const legacyDay = { day: '2026-09-17', tokens: 125, requests: 1 } as UserUsageDay
    const last = buildUsageDaySeries([legacyDay], '7d', new Date(2026, 8, 17)).at(-1)

    expect(last).toEqual({ day: '2026-09-17', coworkTokens: 0, codeTokens: 125, autoTokens: 0, totalTokens: 125, userMessages: 0, turns: 1, modelCalls: 0 })
  })

  test('Given 连续序列 When 汇总范围 Then 两个模式及总量分别准确累计', () => {
    const totals = summarizeUsageRange([
      { day: '2026-09-16', coworkTokens: 10, codeTokens: 20, autoTokens: 5, totalTokens: 35, userMessages: 2, turns: 1, modelCalls: 3 },
      { day: '2026-09-17', coworkTokens: 4, codeTokens: 6, autoTokens: 1, totalTokens: 11, userMessages: 1, turns: 2, modelCalls: 4 },
    ])

    expect(totals).toEqual({ coworkTokens: 14, codeTokens: 26, autoTokens: 6, totalTokens: 46, userMessages: 3, turns: 3, modelCalls: 7 })
  })

  test('Given Code 日汇总含 Auto 子集 When 构造序列 Then 主调用与 Auto 拆分且总量不重复', () => {
    const last = buildUsageDaySeries([
      usageDay({ day: '2026-09-17', tokens: 100, codeTokens: 100, autoTokens: 25 }),
    ], '7d', new Date(2026, 8, 17)).at(-1)

    expect(last).toMatchObject({ codeTokens: 75, autoTokens: 25, totalTokens: 100 })
  })

  test('Given 大小不同的 Token 数 When 格式化卡片和坐标轴 Then 使用稳定的紧凑单位', () => {
    expect(formatCompactTokens(311_700_000)).toBe('311.7M')
    expect(formatCompactTokens(4_020)).toBe('4.0k')
    expect(formatAxisTokens(200_000_000)).toBe('200M')
    expect(formatAxisTokens(50_000)).toBe('50k')
    expect(formatAxisTokens(2_140_000)).toBe('2.1M')
    expect(formatAxisTokens(1_605_000)).toBe('1.6M')
  })
})
