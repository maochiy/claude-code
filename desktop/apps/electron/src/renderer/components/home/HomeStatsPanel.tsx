/**
 * HomeStatsPanel — 主页统计面板（Claude 桌面端样式，实测 480px 灰卡）
 *
 * 头部「Overview / Models」页签 + 「All / 30d / 7d」范围切换：选中项为白底描边胶囊；
 * 概览页：2×4 灰色统计格 + 26 周蓝色热力图 + 趣味换算文案；
 * 模型页：按调用次数排序的常用模型列表。
 * 数据来自主进程 getUserUsageSummary（聚合本地 JSONL 真实用量）。
 *
 * 范围切换统一过滤 Token、消息、轮次、调用、会话、峰值日和模型排行；
 * 连续天数仍是跨完整历史计算的账户指标。
 */

import * as React from 'react'
import { buildProfileActivity } from '@/lib/profile-activity'
import { cn } from '@/lib/utils'
import type { UserUsageSummary } from '@/types/user-profile'
import { useTranslation } from '@/lib/i18n'

/** 统计范围 */
type StatsRange = 'all' | '30d' | '7d'
/** 面板页签 */
type StatsTab = 'overview' | 'models'

const RANGE_OPTIONS: Array<{ value: StatsRange; label: string; days: number | null }> = [
  { value: 'all', label: 'All', days: null },
  { value: '30d', label: '30d', days: 30 },
  { value: '7d', label: '7d', days: 7 },
]

/** 《魔戒》三部曲约 48 万词，按英文 1 词 ≈ 1.33 Token 估算 */
const LOTR_BOOK_TOKENS = 640_000

/** 西式紧凑数字：329.4M / 15.2K（对齐 Claude 桌面端展示风格） */
export function formatCompactNumber(value: number): string {
  const next = Number(value || 0)
  if (!Number.isFinite(next) || next <= 0) return '0'
  const trim = (n: number): string => {
    const rounded = Math.round(n * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (next >= 1_000_000_000) return `${trim(next / 1_000_000_000)}B`
  if (next >= 1_000_000) return `${trim(next / 1_000_000)}M`
  if (next >= 10_000) return `${trim(next / 1_000)}K`
  return Math.round(next).toLocaleString('en-US')
}

/** 热力图单元格颜色：空格用裸分量兜底色，其余按实测蓝阶 token 分层（token 值为完整颜色，直接 var() 引用） */
function heatmapCellColor(level: number): string {
  if (level <= 0) return 'hsl(var(--heatmap-empty))'
  const tokens = ['--heatmap-l1', '--heatmap-l2', '--heatmap-l3', '--heatmap-l4']
  return `var(${tokens[Math.min(level, 4) - 1]})`
}

/** 峰值日 YYYY-MM-DD → 英文短日期（Sep 12） */
function formatPeakDay(day: string, locale: string): string {
  const match = day.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return '—'
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

interface HomeStatsPanelProps {
  summary: UserUsageSummary
  loaded: boolean
}

/** 选中态白底描边胶囊（页签/范围共用） */
function PillTab({ selected, onClick, children }: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-[12px] leading-4 transition-colors',
        selected
          ? 'border border-black/[0.09] bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(60_50_30/0.06)]'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function HomeStatsPanel({ summary, loaded }: HomeStatsPanelProps): React.ReactElement {
  const { language } = useTranslation()
  const [tab, setTab] = React.useState<StatsTab>('overview')
  const [range, setRange] = React.useState<StatsRange>('all')

  const { stats } = summary

  /** 范围内的按日记录（'all' 时不过滤） */
  const rangedDays = React.useMemo(() => {
    const option = RANGE_OPTIONS.find((item) => item.value === range)
    if (!option?.days) return summary.days
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - (option.days - 1))
    return summary.days.filter((row) => {
      const date = new Date(`${row.day}T00:00:00`)
      return !Number.isNaN(date.getTime()) && date >= cutoff
    })
  }, [range, summary.days])

  const rangedTokens = React.useMemo(
    () => rangedDays.reduce((sum, row) => sum + (row.tokens || 0), 0),
    [rangedDays],
  )
  const rangedUserMessages = React.useMemo(
    () => rangedDays.reduce((sum, row) => sum + (row.userMessages ?? row.requests ?? 0), 0),
    [rangedDays],
  )
  const rangedTurns = React.useMemo(
    () => rangedDays.reduce((sum, row) => sum + (row.turns ?? row.requests ?? 0), 0),
    [rangedDays],
  )
  const rangedModelCalls = React.useMemo(
    () => rangedDays.reduce((sum, row) => sum + (row.modelCalls ?? 0), 0),
    [rangedDays],
  )
  const hasRangedModelCalls = rangedDays.some((row) => row.modelCalls !== undefined)
  const hasRangedSessionStarts = rangedDays.some(
    (row) => row.agentSessions !== undefined || row.chatSessions !== undefined,
  )
  const rangedSessions = range === 'all'
    ? stats.chatCount + stats.agentSessionCount
    : rangedDays.reduce((sum, row) => sum + (row.agentSessions ?? 0) + (row.chatSessions ?? 0), 0)
  const rangedActiveDays = React.useMemo(
    () => rangedDays.filter((row) => (row.tokens || 0) > 0 || (row.requests || 0) > 0).length,
    [rangedDays],
  )

  /** 26 周热力图（桌面端同款跨度，占满 480px 卡片宽度） */
  const activity = React.useMemo(
    () => buildProfileActivity(summary.days, 'daily', new Date(), formatCompactNumber, 26),
    [summary.days],
  )

  const cutoffDay = rangedDays[0]?.day
  const rangedModels = React.useMemo(() => {
    if (range === 'all' || !cutoffDay) return summary.models
    return summary.models.map((model) => {
      const days = (model.days ?? []).filter((day) => day.day >= cutoffDay)
      return {
        ...model,
        requests: days.reduce((sum, day) => sum + day.requests, 0),
        tokens: days.reduce((sum, day) => sum + day.tokens, 0),
      }
    }).filter((model) => model.requests > 0 || model.tokens > 0)
      .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens)
  }, [cutoffDay, range, summary.models])
  const rangedPeak = rangedDays.reduce<(typeof rangedDays)[number] | undefined>(
    (peak, day) => !peak || day.tokens > peak.tokens ? day : peak,
    undefined,
  )
  const favoriteModel = rangedModels[0]
  const lotrTimes = Math.floor(rangedTokens / LOTR_BOOK_TOKENS)
  const codeUnavailable = !loaded || summary.coverage?.code === 'unavailable'

  const cells: Array<{ label: string; value: string }> = [
    {
      label: language === 'zh' ? '会话' : 'Sessions',
      value: !loaded || (range !== 'all' && !hasRangedSessionStarts) ? '—' : formatCompactNumber(rangedSessions),
    },
    { label: language === 'zh' ? '消息' : 'Messages', value: codeUnavailable ? '—' : formatCompactNumber(rangedUserMessages) },
    { label: language === 'zh' ? 'Token 总量' : 'Total tokens', value: codeUnavailable ? '—' : formatCompactNumber(rangedTokens) },
    { label: language === 'zh' ? '活跃天数' : 'Active days', value: codeUnavailable ? '—' : formatCompactNumber(rangedActiveDays) },
    { label: language === 'zh' ? '当前连续使用' : 'Current streak', value: !loaded ? '—' : `${stats.currentStreakDays}d` },
    { label: language === 'zh' ? '最长连续使用' : 'Longest streak', value: !loaded ? '—' : `${stats.longestStreakDays}d` },
    { label: language === 'zh' ? '峰值日期' : 'Peak day', value: codeUnavailable ? '—' : formatPeakDay(rangedPeak?.day ?? '', language === 'zh' ? 'zh-CN' : 'en-US') },
    { label: language === 'zh' ? '常用模型' : 'Favorite model', value: !loaded ? '—' : favoriteModel ? favoriteModel.modelName || favoriteModel.modelId : '—' },
  ]

  return (
    <section aria-label={language === 'zh' ? '用量统计' : 'Usage statistics'} className="w-full max-w-[480px] rounded-2xl bg-muted p-3">
      {/* 头部：页签 + 范围切换 */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="tablist" aria-label={language === 'zh' ? '统计页签' : 'Statistics tabs'}>
          <PillTab selected={tab === 'overview'} onClick={() => setTab('overview')}>
            {language === 'zh' ? '概览' : 'Overview'}
          </PillTab>
          <PillTab selected={tab === 'models'} onClick={() => setTab('models')}>
            {language === 'zh' ? '模型' : 'Models'}
          </PillTab>
        </div>
        <div className="flex items-center gap-1" aria-label={language === 'zh' ? '统计范围' : 'Statistics range'}>
          {RANGE_OPTIONS.map((option) => (
            <PillTab
              key={option.value}
              selected={range === option.value}
              onClick={() => setRange(option.value)}
            >
              {option.value === 'all' && language === 'zh' ? '全部' : option.label}
            </PillTab>
          ))}
        </div>
      </div>

      {tab === 'overview' ? (
        <>
          {/* 2×4 灰色统计格（底色区分，无边框） */}
          <div className="grid grid-cols-4 gap-1">
            {cells.map((cell) => (
              <div key={cell.label} className="min-w-0 rounded-md bg-foreground/[0.05] px-2 py-1.5">
                <div className="truncate text-[11px] leading-4 text-muted-foreground">{cell.label}</div>
                <div
                  className="mt-0.5 truncate text-[15px] font-semibold leading-5 tracking-tight text-foreground"
                  title={cell.value}
                >
                  {cell.value}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
            <span>{language === 'zh' ? '完成轮次' : 'Completed turns'} {formatCompactNumber(rangedTurns)}</span>
            <span>
              {language === 'zh' ? '模型调用' : 'Model calls'}{' '}
              {hasRangedModelCalls ? formatCompactNumber(rangedModelCalls) : '—'}
            </span>
            {summary.coverage?.code === 'partial' ? (
              <span className="ml-auto text-amber-600 dark:text-amber-400">
                {language === 'zh' ? '部分会话未计入' : 'Partial data'}
              </span>
            ) : null}
          </div>

          {/* 26 周蓝色热力图 */}
          <div className="overflow-hidden pt-3" aria-busy={!loaded}>
            <div
              className="grid w-max"
              style={{
                gap: '2.5px',
                gridTemplateRows: 'repeat(7, 15px)',
                gridAutoFlow: 'column',
                gridAutoColumns: '15px',
              }}
              aria-label={language === 'zh' ? 'Token 活动网格' : 'Token activity grid'}
            >
              {activity.cells.map((cell) => (
                <span
                  key={cell.day}
                  title={cell.ariaLabel}
                  className="size-[15px] rounded-[3px]"
                  style={{ background: heatmapCellColor(cell.level) }}
                />
              ))}
            </div>
          </div>

          {/* 趣味换算文案 */}
          {lotrTimes >= 1 && (
            <p className="px-1 pt-3 text-[12.5px] text-muted-foreground/90">
              {language === 'zh'
                ? `你使用的 Token 约为《指环王》三部曲字数的 ${lotrTimes.toLocaleString('zh-CN')} 倍。`
                : `You've used ~${lotrTimes.toLocaleString('en-US')}x more tokens than The Lord of the Rings.`}
            </p>
          )}
        </>
      ) : (
        /* 模型页：按调用次数排序的轻量柱状图 */
        <div className="px-1 pb-1">
          {rangedModels.length > 0 ? (
            (() => {
              const models = rangedModels.slice(0, 6)
              const peakRequests = Math.max(...models.map((model) => model.requests), 1)
              return models.map((model) => {
                const label = model.modelName || model.modelId
                const width = Math.max(4, Math.round((model.requests / peakRequests) * 100))
                return (
                  <div key={model.modelId} className="py-2">
                    <div className="mb-1 flex items-center justify-between gap-3 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-foreground" title={label}>{label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {model.requests.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')} {language === 'zh' ? '个涉及轮次' : 'turns involved'}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-foreground/[0.07]">
                      <div
                        className="h-full rounded-full bg-primary/75 transition-[width]"
                        style={{ width: `${width}%` }}
                        aria-label={`${label}: ${model.requests} calls`}
                      />
                    </div>
                    <div className="mt-1 text-[11px] tabular-nums text-muted-foreground/75">
                      {formatCompactNumber(model.tokens)} {language === 'zh' ? 'Token' : 'tokens'}
                    </div>
                  </div>
                )
              })
            })()
          ) : (
            <p className="py-6 text-center text-[12.5px] text-muted-foreground">
              {language === 'zh' ? '还没有模型用量，首次对话后会显示统计。' : 'No model usage yet. Stats will appear after your first conversation.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
