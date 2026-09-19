/**
 * ContextUsageBadge — 上下文使用量指示器（参考截图 15-17）
 *
 * 输入卡内底行左侧的胶囊（variant="text"）：
 * - 文案「上下文 12.6k/200k (6%) ›」，随布局流动
 * - hover / click 弹出 Popover：标题 + 进度条 + 少量明细行 + 手动压缩按钮
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近 CCB 回传的动态压缩阈值时进入琥珀色告警态
 * - 无数据时不显示
 */

import * as React from 'react'
import { ChevronRight, Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { cn } from '@/lib/utils'
import {
  type ChannelPlanQuotaResult,
  type ChannelPlanQuotaWindow,
} from '@proma/shared'
import { fetchChannelPlanQuota } from '@/lib/channel-plan-quota'
import { useTranslation } from '@/lib/i18n'
import type { AgentContextUsageBreakdown, AgentContextUsageCategory } from '@/lib/agent-context-usage'

/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150
const UNSUPPORTED_PLAN_QUOTA_MESSAGE = '当前渠道不支持订阅 Plan 额度查询'

export interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  contextWindow?: number
  /** 当前上下文 token 是否为 CCB 压缩后的估算值 */
  isEstimated: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
  isCompacting: boolean
  isProcessing: boolean
  onCompact: () => void
  /**
   * 当前会话 ID，用于在切换会话时清空 stableRef，
   * 避免新会话尚未发消息时仍显示上一个会话的 token 数。
   */
  sessionId?: string
  /** 当前 Agent 渠道 ID，用于 hover 时查询订阅 Plan 剩余额度 */
  channelId?: string | null
  /** 渠道保存时间；凭据变更后用于使旧额度缓存失效。 */
  channelUpdatedAt?: number
  /** icon：36×36 圆环按钮（默认）；text："上下文 X/Y (N%) ›" 文字胶囊 */
  variant?: 'icon' | 'text'
  /** Runtime get_context_usage 返回的真实分类；缺失时保留精简 used/free 视图。 */
  contextBreakdown?: AgentContextUsageBreakdown
  /** 弹层打开时刷新一次，避免逐 token 轮询。 */
  onRequestContextBreakdown?: () => void | Promise<void>
  contextBreakdownLoading?: boolean
  contextBreakdownError?: string
  onAutoCompactChange?: (enabled: boolean) => Promise<void>
}

const CATEGORY_COLORS = ['#7c8fd3', '#d9865b', '#58a58c', '#b178c5', '#ccaa4c', '#6d9fc9', '#a9876d']

export interface ContextCategoryRow extends AgentContextUsageCategory {
  color: string
  percentage?: number
}

/** 只使用 Runtime 明确返回的分类和容量；缺容量时不推算百分比。 */
export function buildContextCategoryRows(
  breakdown: AgentContextUsageBreakdown | undefined,
): ContextCategoryRow[] {
  if (!breakdown) return []
  const capacity = breakdown.maxTokens && breakdown.maxTokens > 0 ? breakdown.maxTokens : undefined
  return breakdown.categories
    .filter((category) => Number.isFinite(category.tokens) && category.tokens >= 0)
    .map((category, index) => {
      const runtimeColor = category.color?.trim()
      const safeColor = runtimeColor && /^(#[\da-f]{3,8}|(?:rgb|hsl)a?\(|var\(--)/i.test(runtimeColor)
        ? runtimeColor
        : CATEGORY_COLORS[index % CATEGORY_COLORS.length]!
      return {
        ...category,
        color: safeColor,
        ...(capacity ? { percentage: Math.round((category.tokens / capacity) * 100) } : {}),
      }
    })
}

/** 格式化 token 数为可读字符串（如 1234 → "1.2k"） */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px（更多菜单触发器复用） */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
export function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-[#5993D9] dark:text-[#86ACEA]',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

function formatResetTime(timestamp?: number): string | undefined {
  if (!timestamp) return undefined
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function PlanQuotaRow({ quotaWindow }: { quotaWindow: ChannelPlanQuotaWindow }): React.ReactElement {
  const { t } = useTranslation()
  const resetText = formatResetTime(quotaWindow.resetAt)
  const value = `${t('context.remaining', { value: quotaWindow.remainingLabel ?? `${quotaWindow.remainingPercent}%` })}${resetText ? ` · ${resetText}` : ''}`
  return (
    <div className="space-y-1">
      <DetailRow
        label={quotaWindow.label}
        value={value}
        emphasized={quotaWindow.remainingPercent <= 20}
      />
      {quotaWindow.showProgress !== false ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full rounded-full',
              quotaWindow.remainingPercent <= 20 ? 'bg-amber-500' : 'bg-foreground/60',
            )}
            style={{ width: `${Math.max(0, Math.min(100, quotaWindow.remainingPercent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function ContextBreakdownFeedback({
  loading,
  error,
  loadingLabel,
}: {
  loading: boolean
  error?: string
  loadingLabel: string
}): React.ReactElement | null {
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {loadingLabel}
      </div>
    )
  }
  if (error) {
    return <p role="alert" className="text-[11px] text-destructive">{error}</p>
  }
  return null
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  contextWindow,
  isEstimated,
  autoCompactEnabled,
  autoCompactThreshold,
  effectiveContextWindow,
  isCompacting,
  isProcessing,
  onCompact,
  sessionId,
  channelId,
  channelUpdatedAt,
  variant = 'icon',
  contextBreakdown,
  onRequestContextBreakdown,
  contextBreakdownLoading = false,
  contextBreakdownError,
  onAutoCompactChange,
}: ContextUsageBadgeProps): React.ReactElement | null {
  const { t, language } = useTranslation()
  const [changingAutoCompact, setChangingAutoCompact] = React.useState(false)
  const [autoCompactError, setAutoCompactError] = React.useState<string>()
  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<{
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    contextWindow?: number
  } | null>(null)
  // 会话切换时清空陈旧值，避免新会话尚未上报 usage 时显示上个会话的数字
  const lastSessionRef = React.useRef<string | undefined>(sessionId)
  React.useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      stableRef.current = null
      lastSessionRef.current = sessionId
    }
  }, [sessionId])
  if (inputTokens && inputTokens > 0) {
    stableRef.current = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      contextWindow,
    }
  }

  const [open, setOpen] = React.useState(false)
  const [detailsExpanded, setDetailsExpanded] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  // 保留上次成功/失败结果；悬浮刷新期间继续展示旧值，直到新结果到达后原位替换。
  const [quota, setQuota] = React.useState<ChannelPlanQuotaResult | null>(null)

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  React.useEffect(() => {
    if (!open || !channelId) return

    let cancelled = false

    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setQuota(result)
      })

    return () => {
      cancelled = true
    }
  }, [open, channelId, channelUpdatedAt])

  React.useEffect(() => {
    if (!open || !onRequestContextBreakdown) return
    void Promise.resolve(onRequestContextBreakdown())
      .catch((error) => console.error('[上下文] 刷新分类失败:', error))
  }, [open, onRequestContextBreakdown])

  // 压缩中 → 按钮位置显示 spinner
  if (isCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(inputToolbarButtonClass, 'text-muted-foreground cursor-default')}
        disabled
        aria-label={t('sidePanel.saving')}
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = inputTokens != null && inputTokens > 0
  const runtimeTotal = contextBreakdown?.totalTokens != null
    && Number.isFinite(contextBreakdown.totalTokens) && contextBreakdown.totalTokens >= 0
    ? contextBreakdown.totalTokens
    : undefined
  const displayTokens = runtimeTotal ?? (hasCurrent ? inputTokens : stable?.inputTokens)
  // contextWindow 本身就要参与展示：新 Runtime 首次模型调用前可能只有
  // 上下文窗口/压缩策略而没有 usage，此时入口仍然要显示（圆环按 0% 渲染）。
  const runtimeWindow = contextBreakdown?.maxTokens != null
    && Number.isFinite(contextBreakdown.maxTokens) && contextBreakdown.maxTokens > 0
    ? contextBreakdown.maxTokens
    : undefined
  const displayWindow = runtimeWindow ?? effectiveContextWindow ?? contextWindow ?? stable?.contextWindow
  const displayOutput = hasCurrent ? outputTokens : stable?.outputTokens
  const displayCacheRead = hasCurrent ? cacheReadTokens : stable?.cacheReadTokens

  // 新 Runtime 首次模型调用前可能只有上下文窗口/压缩策略，没有 usage。
  // 仍然保留入口，保证用户可以查看策略并触发手动压缩。
  const hasContextMetadata = Boolean(
    displayWindow
    || contextBreakdown
    || autoCompactEnabled !== undefined
    || autoCompactThreshold !== undefined
    || effectiveContextWindow !== undefined,
  )
  if ((!displayTokens || displayTokens <= 0) && !hasContextMetadata) return null
  const visibleTokens = displayTokens ?? 0

  // 仅使用 CCB Runtime 回传的真实阈值；未拿到配置时不自行猜测。
  const compactThreshold = autoCompactEnabled === false
    ? undefined
    : autoCompactThreshold
  const isWarning = compactThreshold && compactThreshold > 0
    ? visibleTokens / compactThreshold >= WARNING_RATIO
    : false
  const ratio = displayWindow ? visibleTokens / displayWindow : 0
  const categoryRows = buildContextCategoryRows(contextBreakdown)
  const visibleCategoryRows = categoryRows.filter(
    (category) => !category.isDeferred && category.name.trim().toLowerCase() !== 'free space',
  )

  const percent = displayWindow
    ? Math.round((visibleTokens / displayWindow) * 100)
    : undefined

  const handleCompactClick = (): void => {
    if (isProcessing) return
    onCompact()
    setOpen(false)
  }

  const shouldShowPlanQuota = quota != null && (
    quota.supported
    || quota.windows.length > 0
    || quota.message !== UNSUPPORTED_PLAN_QUOTA_MESSAGE
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'text' ? (
          <button
            type="button"
            aria-label={t('context.usageSettings')}
            className={cn(
              'flex h-7 min-w-0 max-w-[240px] items-center gap-0.5 rounded-md px-1.5 text-[12px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/55 hover:text-foreground',
            )}
            onMouseEnter={() => {
              cancelClose()
              setOpen(true)
            }}
            onMouseLeave={scheduleClose}
          >
            <span className="truncate tabular-nums">
              {displayWindow
                ? `${t('context.label')} ${formatTokens(visibleTokens)}/${formatTokens(displayWindow)} (${percent ?? 0}%)`
                : `${t('context.label')} ${formatTokens(visibleTokens)}`}
            </span>
            <ChevronRight className="size-3 shrink-0 opacity-60" />
          </button>
        ) : (
          <Button
            type="button"
            aria-label={t('context.usageSettings')}
            variant="ghost"
            size="icon"
            className={cn(
              inputToolbarButtonClass,
              isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/60 hover:text-foreground',
            )}
            onMouseEnter={() => {
              cancelClose()
              setOpen(true)
            }}
            onMouseLeave={scheduleClose}
          >
            <UsageRing ratio={ratio} isWarning={isWarning} />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-32px)] rounded-xl p-3"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setDetailsExpanded((expanded) => !expanded)}
            aria-expanded={detailsExpanded}
            className="flex items-center justify-between gap-3 text-left text-xs text-muted-foreground"
          >
            <span>{t('context.window')}{isEstimated ? t('context.estimated') : ''}</span>
            <span className="ml-auto tabular-nums">
              {displayWindow
                ? `${formatTokens(visibleTokens)} / ${formatTokens(displayWindow)} (${percent ?? 0}%)`
                : `${formatTokens(visibleTokens)} tokens`}
            </span>
            <ChevronRight className={cn('size-3 shrink-0 transition-transform', detailsExpanded && 'rotate-90')} />
          </button>
          <ContextBreakdownFeedback
            loading={contextBreakdownLoading}
            error={contextBreakdownError}
            loadingLabel={language === 'zh' ? '正在读取上下文详情' : 'Loading context details'}
          />
          {/* Runtime 有分类时逐项展示；未接入分类时才回退 used/free 两段。 */}
          {displayWindow && percent != null ? (
            <>
              <div className="flex h-1.5 overflow-hidden rounded-full">
                {visibleCategoryRows.length > 0
                  ? visibleCategoryRows.map((category) => (
                    <div
                      key={category.name}
                      className="h-full"
                      style={{
                        backgroundColor: category.color,
                        width: `${Math.max(0, Math.min(100, category.percentage ?? 0))}%`,
                      }}
                    />
                  ))
                  : <div
                      className={cn('h-full', isWarning ? 'bg-amber-500' : 'bg-[#5993D9] dark:bg-[#86ACEA]')}
                      style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                    />}
                <div className="h-full flex-1 bg-foreground/10" />
              </div>
              <div className="mt-0.5 flex flex-col gap-1">
                {visibleCategoryRows.length > 0 ? visibleCategoryRows.map((category) => (
                  <div key={category.name} className="flex items-center gap-1.5 text-xs">
                    <span className="size-2 rounded-[3px]" style={{ backgroundColor: category.color }} />
                    <span className="min-w-0 truncate text-foreground/70" title={category.name}>{category.name}</span>
                    <span className="ml-auto tabular-nums text-foreground/90">{formatTokens(category.tokens)}</span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">{category.percentage ?? 0}%</span>
                  </div>
                )) : (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={cn('size-2 rounded-[3px]', isWarning ? 'bg-amber-500' : 'bg-[#5993D9] dark:bg-[#86ACEA]')} />
                    <span className="text-foreground/70">{t('context.used')}</span>
                    <span className="ml-auto tabular-nums text-foreground/90">{formatTokens(visibleTokens)}</span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">{percent}%</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="size-2 rounded-[3px] bg-foreground/10" />
                  <span className="text-foreground/70">{t('context.free')}</span>
                  <span className="ml-auto tabular-nums text-foreground/90">{formatTokens(Math.max(0, displayWindow - visibleTokens))}</span>
                  <span className="w-12 text-right tabular-nums text-muted-foreground">{100 - percent}%</span>
                </div>
              </div>
            </>
          ) : null}
          {!displayWindow && visibleCategoryRows.length > 0 ? (
            <div className="mt-0.5 flex flex-col gap-1">
              {visibleCategoryRows.map((category) => (
                <div key={category.name} className="flex items-center gap-1.5 text-xs">
                  <span className="size-2 rounded-[3px]" style={{ backgroundColor: category.color }} />
                  <span className="min-w-0 truncate text-foreground/70" title={category.name}>{category.name}</span>
                  <span className="ml-auto tabular-nums text-foreground/90">{formatTokens(category.tokens)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {detailsExpanded && (
            <>
              <DetailRow label={t('context.input')} value={formatTokens(visibleTokens)} emphasized />
              {displayOutput ? <DetailRow label={t('context.output')} value={displayOutput.toLocaleString()} /> : null}
              {displayCacheRead ? <DetailRow label={t('context.cacheRead')} value={formatTokens(displayCacheRead)} /> : null}
              {displayWindow ? <DetailRow label={t('context.availableWindow')} value={formatTokens(displayWindow)} /> : null}

              {shouldShowPlanQuota ? (
                <>
                  <div className="h-px bg-border my-0.5" />
                  <div className="text-[11px] font-medium text-foreground/70">
                    {t('context.planQuota')}{quota?.planName ? ` · ${quota.planName}` : ''}
                  </div>
                  {quota?.supported && quota.windows.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {quota.windows.map((quotaWindow) => (
                        <PlanQuotaRow key={`${quotaWindow.type}-${quotaWindow.label}`} quotaWindow={quotaWindow} />
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] text-foreground/50">
                      {quota?.message ?? t('context.planFailed')}
                    </div>
                  )}
                </>
              ) : null}

              <div className="h-px bg-border my-0.5" />
              <Button
                type="button"
                variant={isWarning ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'h-7 text-xs gap-1.5',
                  isWarning && 'bg-amber-500 hover:bg-amber-600 text-white',
                )}
                onClick={handleCompactClick}
                disabled={isProcessing}
              >
                <Minimize2 className="size-3.5" />
                {isProcessing ? t('context.processing') : t('context.compact')}
              </Button>
            </>
          )}
          <div className="mt-1 border-t border-border pt-2">
            {onAutoCompactChange && typeof contextBreakdown?.autoCompactEnabled === 'boolean' ? (
              <label className="mb-2 flex items-center justify-between gap-3 text-xs">
                {language === 'zh' ? '此会话自动压缩' : 'Auto-compact this session'}
                <input
                  type="checkbox"
                  checked={contextBreakdown.autoCompactEnabled}
                  disabled={changingAutoCompact}
                  onChange={(event) => {
                    setChangingAutoCompact(true)
                    setAutoCompactError(undefined)
                    void onAutoCompactChange(event.currentTarget.checked)
                      .catch((error: unknown) => setAutoCompactError(error instanceof Error ? error.message : String(error)))
                      .finally(() => setChangingAutoCompact(false))
                  }}
                />
              </label>
            ) : null}
            {autoCompactError ? <p role="alert" className="mb-2 text-xs text-destructive">{autoCompactError}</p> : null}
            <button
              type="button"
              onClick={() => setDetailsExpanded((expanded) => !expanded)}
              className="w-full text-left text-xs text-foreground/75 hover:text-foreground"
            >
              {detailsExpanded ? t('context.collapse') : t('context.details')}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
