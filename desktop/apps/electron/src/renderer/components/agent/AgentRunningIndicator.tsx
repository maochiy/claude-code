import * as React from 'react'
import type { AgentTurnStatus } from '@/lib/agent-turn-status'
import { getAgentTurnStatusLabel } from '@/lib/agent-turn-status'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

interface AgentRunningIndicatorProps {
  startedAt?: number
  model?: string
  status?: AgentTurnStatus
  tokenCount?: number
  className?: string
}

function useElapsedSeconds(startedAt: number | undefined): number | undefined {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt == null ? undefined : Math.max(0, Math.floor((now - startedAt) / 1_000))
}

/** 首个模型事件之前立即展示单行占位，不重复堆叠状态栏和思考面板。 */
export function AgentRunningIndicator({
  startedAt, model, status, tokenCount, className,
}: AgentRunningIndicatorProps): React.ReactElement {
  const { language } = useTranslation()
  const elapsedSeconds = useElapsedSeconds(startedAt)
  const waitingLabel = language === 'zh' ? '正在等待 Claude…' : 'Waiting for Claude…'
  return (
    <div role="status" title={model ? (language === 'zh' ? `使用 ${model}` : `Using ${model}`) : undefined}
      data-agent-activity={status === 'thinking' ? 'thinking' : 'waiting'}
      className={cn('agent-activity-fade-in flex min-h-7 items-center gap-1.5 py-1 text-[13px] leading-5 text-muted-foreground', className)}
    >
      <span aria-hidden="true" className="shrink-0 text-[#D97745]">✳</span>
      <span className="agent-status-shimmer">
        {status ? getAgentTurnStatusLabel(status, language) : waitingLabel}
      </span>
      {elapsedSeconds != null && <span className="tabular-nums text-muted-foreground/65">· {elapsedSeconds}s</span>}
      {tokenCount != null && tokenCount > 0 && (
        <span className="tabular-nums text-muted-foreground/65">· {tokenCount.toLocaleString()} tokens</span>
      )}
    </div>
  )
}
