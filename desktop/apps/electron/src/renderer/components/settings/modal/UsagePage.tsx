/**
 * 设置模态框用量页。
 *
 * 数据来自本机 JSONL 汇总，按 Cowork / Code / Auto 展示真实 Token 用量。
 */

import * as React from 'react'
import { BarChart3, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation, type InterfaceLanguage } from '@/lib/i18n'
import type { UserUsageSummary } from '../../../../types/user-profile'
import {
  RANGE_DAYS,
  buildUsageDaySeries,
  formatAxisTokens,
  formatCompactTokens,
  summarizeUsageRange,
  type UsageDaySeriesItem,
  type UsageRange,
} from './usage-page-model'

type UsageView = 'chart' | 'table'

interface UsageCopy {
  description: string
  cowork: string
  code: string
  auto: string
  tokensPerDay: string
  byDay: (days: number) => string
  chart: string
  table: string
  date: string
  total: string
  notRecorded: string
  codeSource: string
  autoSource: string
  recordedTokens: string
  messages: string
  turns: string
  modelCalls: string
  unavailable: string
  partial: string
}

const COPY: Record<InterfaceLanguage, UsageCopy> = {
  zh: {
    description: '此设备上 Cowork 和 Code 模式的 Token 用量。费用不在此显示，组织将按所配置渠道的价格计费。',
    cowork: 'Cowork',
    code: 'Code',
    auto: 'Auto',
    tokensPerDay: '每日 Token',
    byDay: (days) => `最近 ${days} 天按模式统计的输入和输出 Token`,
    chart: '图表视图',
    table: '表格视图',
    date: '日期',
    total: '合计',
    notRecorded: 'Cowork 历史用量尚未记录',
    codeSource: '来自本机 Code 会话',
    autoSource: 'Auto classifier 独立模型调用',
    recordedTokens: '已记录 Token',
    messages: '用户消息',
    turns: '完成轮次',
    modelCalls: '模型调用',
    unavailable: '暂无可用记录',
    partial: '部分会话读取失败',
  },
  en: {
    description: 'Token usage on this device across Cowork and Code. Costs are not shown — your organization is billed at its configured provider rates.',
    cowork: 'Cowork',
    code: 'Code',
    auto: 'Auto',
    tokensPerDay: 'Tokens per day',
    byDay: (days) => `Input and output tokens by mode, last ${days} days`,
    chart: 'Chart view',
    table: 'Table view',
    date: 'Date',
    total: 'Total',
    notRecorded: 'Historical Cowork usage is not recorded yet',
    codeSource: 'From local Code sessions',
    autoSource: 'Independent Auto classifier calls',
    recordedTokens: 'recorded tokens',
    messages: 'User messages',
    turns: 'Completed turns',
    modelCalls: 'Model calls',
    unavailable: 'Usage records unavailable',
    partial: 'Some sessions could not be read',
  },
}

function formatDate(day: string, language: InterfaceLanguage): string {
  const [year, month, date] = day.split('-').map(Number)
  const value = new Date(year ?? 0, (month ?? 1) - 1, date ?? 1)
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: language === 'zh' ? 'long' : 'short',
    day: 'numeric',
  }).format(value)
}

function formatShortDate(day: string, language: InterfaceLanguage): string {
  const [, month, date] = day.split('-').map(Number)
  return language === 'zh' ? `${month}月${date}日` : `${month}/${date}`
}

function tokenLabel(tokens: number): string {
  return `${Math.max(0, Math.round(tokens)).toLocaleString()} tokens`
}

function UsageTooltip({ item, language }: {
  item: UsageDaySeriesItem
  language: InterfaceLanguage
}): React.ReactElement {
  const copy = COPY[language]
  return (
    <div className="w-[152px] rounded-lg border border-border/70 bg-popover px-3 py-2.5 text-[12px] text-popover-foreground shadow-lg">
      <div className="mb-2 font-medium">{formatDate(item.day, language)}</div>
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-sm bg-[#ee5b32]" />
        <span className="tabular-nums">{item.coworkTokens.toLocaleString()}</span>
        <span className="ml-auto text-muted-foreground">{copy.cowork}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="size-2.5 rounded-sm bg-[#13a578]" />
        <span className="tabular-nums">{item.codeTokens.toLocaleString()}</span>
        <span className="ml-auto text-muted-foreground">{copy.code}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="size-2.5 rounded-sm bg-[#7c6be8]" />
        <span className="tabular-nums">{item.autoTokens.toLocaleString()}</span>
        <span className="ml-auto text-muted-foreground">{copy.auto}</span>
      </div>
    </div>
  )
}

export function UsageChart({ series, language }: {
  series: UsageDaySeriesItem[]
  language: InterfaceLanguage
}): React.ReactElement {
  const copy = COPY[language]
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const observedMaxTokens = Math.max(0, ...series.map((item) => item.totalTokens))
  const scaleMaxTokens = Math.max(1, observedMaxTokens)
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  const labelIndexes = new Set(
    [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round((series.length - 1) * ratio)),
  )

  return (
    <div className="mt-5" data-usage-chart>
      <div className="flex h-[218px]">
        <div className="relative w-12 shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {ticks.map((ratio) => (
            <span key={ratio} className="absolute right-2 -translate-y-1/2" style={{ top: `${(1 - ratio) * 100}%` }}>
              {formatAxisTokens(observedMaxTokens * ratio)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {ticks.map((ratio) => <div key={ratio} className="border-t border-border/55" />)}
          </div>
          <div className="absolute inset-0 flex items-end gap-px px-0.5">
            {series.map((item, index) => {
              const coworkHeight = (item.coworkTokens / scaleMaxTokens) * 100
              const codeHeight = (item.codeTokens / scaleMaxTokens) * 100
              const autoHeight = (item.autoTokens / scaleMaxTokens) * 100
              return (
                <button
                  key={item.day}
                  type="button"
                  className="group relative flex h-full min-w-0 flex-1 items-end outline-none"
                  aria-label={`${formatDate(item.day, language)}，${copy.cowork} ${tokenLabel(item.coworkTokens)}，${copy.code} ${tokenLabel(item.codeTokens)}，${copy.auto} ${tokenLabel(item.autoTokens)}`}
                  aria-describedby={activeIndex === index ? 'usage-day-tooltip' : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex((current) => current === index ? null : current)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex((current) => current === index ? null : current)}
                >
                  <span className="relative h-full w-full overflow-hidden rounded-t-[3px] opacity-90 transition-opacity group-hover:opacity-100 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1">
                    {codeHeight > 0 && <span className="absolute inset-x-0 bottom-0 bg-[#13a578]" style={{ height: `${codeHeight}%`, minHeight: 2 }} />}
                    {autoHeight > 0 && <span className="absolute inset-x-0 bg-[#7c6be8]" style={{ bottom: `${codeHeight}%`, height: `${autoHeight}%`, minHeight: 2 }} />}
                    {coworkHeight > 0 && <span className="absolute inset-x-0 bg-[#ee5b32]" style={{ bottom: `${codeHeight + autoHeight}%`, height: `${coworkHeight}%`, minHeight: 2 }} />}
                  </span>
                </button>
              )
            })}
          </div>
          {activeIndex !== null && series[activeIndex] && (
            <div
              id="usage-day-tooltip"
              role="tooltip"
              className="pointer-events-none absolute z-20 pb-2"
              style={{
                left: `${series.length > 1 ? (activeIndex / (series.length - 1)) * 100 : 50}%`,
                top: `${100 - (series[activeIndex].totalTokens / scaleMaxTokens) * 100}%`,
                transform: activeIndex === 0
                  ? 'translate(0, -100%)'
                  : activeIndex === series.length - 1
                    ? 'translate(-100%, -100%)'
                    : 'translate(-50%, -100%)',
              }}
            >
              <UsageTooltip item={series[activeIndex]} language={language} />
            </div>
          )}
        </div>
      </div>
      <div className="relative ml-12 mt-2 h-4 text-[10px] tabular-nums text-muted-foreground/70">
        {series.map((item, index) => labelIndexes.has(index) && (
          <span
            key={item.day}
            className="absolute whitespace-nowrap"
            style={{
              left: `${series.length > 1 ? (index / (series.length - 1)) * 100 : 50}%`,
              transform: index === 0 ? undefined : index === series.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {formatShortDate(item.day, language)}
          </span>
        ))}
      </div>
    </div>
  )
}

function UsageTable({ series, language }: {
  series: UsageDaySeriesItem[]
  language: InterfaceLanguage
}): React.ReactElement {
  const copy = COPY[language]
  return (
    <div className="mt-5 max-h-[272px] overflow-auto rounded-lg border border-border/55">
      <div className="sticky top-0 grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr] bg-muted/85 px-3 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur">
        <span>{copy.date}</span><span className="text-right">{copy.cowork}</span><span className="text-right">{copy.code}</span><span className="text-right">{copy.auto}</span><span className="text-right">{copy.total}</span>
      </div>
      {series.map((item) => (
        <div key={item.day} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr] border-t border-border/45 px-3 py-2 text-[12px] tabular-nums">
          <span>{formatDate(item.day, language)}</span>
          <span className="text-right text-[#d95631] dark:text-[#ff7954]">{item.coworkTokens.toLocaleString()}</span>
          <span className="text-right text-[#128968] dark:text-[#37c99a]">{item.codeTokens.toLocaleString()}</span>
          <span className="text-right text-[#6f5ed6] dark:text-[#a99cff]">{item.autoTokens.toLocaleString()}</span>
          <span className="text-right font-medium">{item.totalTokens.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

export function UsagePage(): React.ReactElement {
  const { language } = useTranslation()
  const copy = COPY[language]
  const [summary, setSummary] = React.useState<UserUsageSummary | null>(null)
  const [range, setRange] = React.useState<UsageRange>('30d')
  const [view, setView] = React.useState<UsageView>('chart')
  const [loadFailed, setLoadFailed] = React.useState(false)

  const refreshSummary = React.useCallback((): void => {
    window.electronAPI.getUserUsageSummary()
      .then((next) => {
        setSummary(next)
        setLoadFailed(false)
      })
      .catch((error) => {
        setLoadFailed(true)
        console.error('[设置] 加载用量失败:', error)
      })
  }, [])

  React.useEffect(() => {
    refreshSummary()
    const handleVisible = (): void => {
      if (document.visibilityState === 'visible') refreshSummary()
    }
    window.addEventListener('focus', refreshSummary)
    document.addEventListener('visibilitychange', handleVisible)
    const timer = window.setInterval(refreshSummary, 15_000)
    return () => {
      window.removeEventListener('focus', refreshSummary)
      document.removeEventListener('visibilitychange', handleVisible)
      window.clearInterval(timer)
    }
  }, [refreshSummary])

  const series = React.useMemo(() => buildUsageDaySeries(summary?.days ?? [], range), [summary, range])
  const totals = React.useMemo(() => summarizeUsageRange(series), [series])
  const coworkUnavailable = loadFailed || !summary || summary.coverage?.cowork === 'unavailable'
  const codeUnavailable = loadFailed || !summary || summary.coverage?.code === 'unavailable'

  return (
    <div className="mx-auto w-full max-w-[824px] px-6 pb-10 pt-14" data-settings-page="usage">
      <div className="flex items-start justify-between gap-5">
        <p className="max-w-[560px] text-[13px] leading-5 text-muted-foreground">{copy.description}</p>
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5" aria-label="Usage range">
          {(['7d', '30d', '90d'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              onClick={() => setRange(value)}
              className={cn('rounded-[7px] px-3 py-1 text-[12px] transition-colors', range === value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        {([
          { label: copy.cowork, value: totals.coworkTokens, note: copy.notRecorded, unavailable: coworkUnavailable },
          {
            label: copy.code,
            value: totals.codeTokens,
            note: codeUnavailable
              ? copy.unavailable
              : summary?.coverage?.code === 'partial'
                ? copy.partial
                : copy.codeSource,
            unavailable: codeUnavailable,
          },
          {
            label: copy.auto,
            value: totals.autoTokens,
            note: copy.autoSource,
            unavailable: codeUnavailable,
          },
        ] as const).map((item) => (
          <div key={item.label} className="rounded-xl border border-border/65 bg-card/50 px-4 py-4">
            <div className="text-[14px] text-muted-foreground">{item.label}</div>
            <div className="mt-1.5 text-[20px] font-medium tabular-nums text-foreground">
              {item.unavailable ? '—' : formatCompactTokens(item.value)}
              <span className="ml-1 text-[12px] font-normal text-muted-foreground">{copy.recordedTokens}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground/75">
              {item.note}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: copy.messages, value: totals.userMessages },
          { label: copy.turns, value: totals.turns },
          { label: copy.modelCalls, value: totals.modelCalls },
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-foreground/[0.045] px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{item.label}</div>
            <div className="mt-0.5 text-[14px] font-medium tabular-nums">{item.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      <section className="mt-4 rounded-xl border border-border/65 bg-card/50 px-4 pb-4 pt-3.5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[14px] font-medium text-foreground">{copy.tokensPerDay}</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{copy.byDay(RANGE_DAYS[range])}</p>
          </div>
          <div className="flex rounded-md bg-foreground/[0.06] p-0.5">
            <button type="button" aria-label={copy.chart} aria-pressed={view === 'chart'} onClick={() => setView('chart')} className={cn('rounded p-1.5', view === 'chart' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <BarChart3 className="size-4" />
            </button>
            <button type="button" aria-label={copy.table} aria-pressed={view === 'table'} onClick={() => setView('table')} className={cn('rounded p-1.5', view === 'table' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <Table2 className="size-4" />
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#ee5b32]" />{copy.cowork}</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#13a578]" />{copy.code}</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#7c6be8]" />{copy.auto}</span>
        </div>

        {view === 'chart' ? <UsageChart series={series} language={language} /> : <UsageTable series={series} language={language} />}
      </section>
    </div>
  )
}
