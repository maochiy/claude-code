import type { UserUsageDay } from '../../../../types/user-profile'

export type UsageRange = '7d' | '30d' | '90d'

export const RANGE_DAYS: Record<UsageRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

export interface UsageDaySeriesItem {
  day: string
  coworkTokens: number
  codeTokens: number
  autoTokens: number
  totalTokens: number
  userMessages: number
  turns: number
  modelCalls: number
}

export interface UsageRangeTotals {
  coworkTokens: number
  codeTokens: number
  autoTokens: number
  totalTokens: number
  userMessages: number
  turns: number
  modelCalls: number
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 构造连续的本地日期序列。旧版汇总没有分模式字段，按既有语义归入 Code。
 */
export function buildUsageDaySeries(
  days: UserUsageDay[],
  range: UsageRange,
  now: Date = new Date(),
): UsageDaySeriesItem[] {
  const byDay = new Map(days.map((item) => [item.day, item]))
  const result: UsageDaySeriesItem[] = []

  for (let offset = RANGE_DAYS[range] - 1; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    date.setDate(date.getDate() - offset)
    const day = localDayKey(date)
    const source = byDay.get(day)
    const hasCategoryBreakdown = source
      && Number.isFinite(source.coworkTokens)
      && Number.isFinite(source.codeTokens)
    const coworkTokens = hasCategoryBreakdown ? Math.max(0, source.coworkTokens) : 0
    const codeWithAutoTokens = hasCategoryBreakdown
      ? Math.max(0, source.codeTokens)
      : Math.max(0, source?.tokens ?? 0)
    const autoTokens = Math.min(codeWithAutoTokens, Math.max(0, source?.autoTokens ?? 0))
    const codeTokens = codeWithAutoTokens - autoTokens

    result.push({
      day,
      coworkTokens,
      codeTokens,
      autoTokens,
      totalTokens: coworkTokens + codeTokens + autoTokens,
      userMessages: Math.max(0, source?.userMessages ?? 0),
      turns: Math.max(0, source?.turns ?? source?.requests ?? 0),
      modelCalls: Math.max(0, source?.modelCalls ?? 0),
    })
  }

  return result
}

export function summarizeUsageRange(series: UsageDaySeriesItem[]): UsageRangeTotals {
  return series.reduce<UsageRangeTotals>(
    (total, item) => ({
      coworkTokens: total.coworkTokens + item.coworkTokens,
      codeTokens: total.codeTokens + item.codeTokens,
      autoTokens: total.autoTokens + item.autoTokens,
      totalTokens: total.totalTokens + item.totalTokens,
      userMessages: total.userMessages + item.userMessages,
      turns: total.turns + item.turns,
      modelCalls: total.modelCalls + item.modelCalls,
    }),
    { coworkTokens: 0, codeTokens: 0, autoTokens: 0, totalTokens: 0, userMessages: 0, turns: 0, modelCalls: 0 },
  )
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return Math.max(0, Math.round(tokens)).toLocaleString('en-US')
}

export function formatAxisTokens(tokens: number): string {
  const compact = (value: number): string => value.toFixed(1).replace(/\.0$/, '')
  if (tokens >= 1_000_000) return `${compact(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${compact(tokens / 1_000)}k`
  return `${Math.round(tokens)}`
}
