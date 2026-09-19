import * as React from 'react'
import { Check } from 'lucide-react'
import { useAtom } from 'jotai'
import type { ModelOption, ThinkingEffortLevel } from '@proma/shared'
import { agentModelSelectorOpenAtom } from '@/atoms/agent-model-control'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type AgentThinkingEffortCapability } from '@/lib/agent-thinking-effort'
import { cn } from '@/lib/utils'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'
import { useTranslation, type TranslationKey } from '@/lib/i18n'

const EFFORT_LABEL_KEYS: Record<ThinkingEffortLevel, TranslationKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
}

interface AgentModelEffortControlProps {
  models: ModelOption[]
  selectedModel: { channelId: string; modelId: string } | null
  loading: boolean
  modelSwitchDisabled: boolean
  capability: AgentThinkingEffortCapability | null
  effortLevel?: ThinkingEffortLevel
  onModelSelect: (model: ModelOption) => void
  onModelListOpen?: () => void
  onEffortChange: (level: ThinkingEffortLevel) => void
}

/**
 * 输入框工具行右侧的模型与思考等级入口（参考截图 7）：
 * 模型名 + 当前档位徽章两个并列触发器，各自弹出独立弹层。
 */
export function AgentModelEffortControl({
  models,
  selectedModel,
  loading,
  modelSwitchDisabled,
  capability,
  effortLevel,
  onModelSelect,
  onModelListOpen,
  onEffortChange,
}: AgentModelEffortControlProps): React.ReactElement {
  const { t } = useTranslation()
  const [modelOpen, setModelOpen] = React.useState(false)
  const [effortOpen, setEffortOpen] = React.useState(false)
  const [modelListRequested, setModelListRequested] = useAtom(agentModelSelectorOpenAtom)
  const listRef = React.useRef<HTMLDivElement>(null)
  const refreshedForOpenRef = React.useRef(false)
  const currentModel = models.find(model =>
    model.channelId === selectedModel?.channelId && model.modelId === selectedModel?.modelId,
  ) ?? models.find(model =>
    model.channelId === selectedModel?.channelId
    && model.modelId === selectedModel?.modelId.replace(/\[1m\]$/i, ''),
  )
  const modelName = currentModel?.modelName || selectedModel?.modelId || t('model.select')

  // Agent 错误卡片等外部入口请求打开模型列表
  React.useEffect(() => {
    if (!modelListRequested) return
    setModelOpen(true)
    setModelListRequested(false)
  }, [modelListRequested, setModelListRequested])

  // 同一次打开只刷新一次模型目录
  React.useEffect(() => {
    if (!modelOpen) {
      refreshedForOpenRef.current = false
      return
    }
    if (!refreshedForOpenRef.current) {
      refreshedForOpenRef.current = true
      onModelListOpen?.()
    }
  }, [modelOpen, onModelListOpen])

  const closeModelList = (): void => {
    setModelOpen(false)
  }

  const handleListKeyDown = (event: React.KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.findIndex(item => item === document.activeElement)
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowUp' ? (currentIndex <= 0 ? items.length : currentIndex) - 1
      : (currentIndex + 1) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Popover open={modelOpen} onOpenChange={nextOpen => { if (nextOpen) setModelOpen(true); else closeModelList() }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('model.current', { name: modelName })}
            aria-expanded={modelOpen}
            className="flex h-7 min-w-0 max-w-[min(220px,25vw)] items-center gap-1 rounded-md px-1.5 text-[13px] transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="truncate text-foreground/80">{modelName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          aria-label={t('model.select')}
          className="w-[220px] rounded-[10px] p-1.5"
        >
          {/* 参考截图 1-4：灰色「Models」组头 + 平铺模型列表 + 行尾灰色序号 */}
          <div className="px-2 pb-1 pt-1.5 text-[12px] leading-4 text-muted-foreground">{t('model.models')}</div>
          {modelSwitchDisabled && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">{t('model.switchAfterTask')}</p>
          )}
          <div
            ref={listRef}
            onKeyDown={handleListKeyDown}
            className="max-h-[min(280px,50vh)] overflow-y-auto overscroll-contain"
          >
            {models.map((model, index) => {
              const selected = model === currentModel
              return (
                <button
                  key={`${model.channelId}:${model.modelId}`}
                  type="button"
                  disabled={modelSwitchDisabled}
                  aria-pressed={selected}
                  onClick={() => {
                    setModelOpen(false)
                    if (!selected) onModelSelect(model)
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
                    !selected && 'enabled:hover:bg-accent/70',
                  )}
                >
                  <span className={cn(
                    'min-w-0 flex-1 truncate',
                    selected ? 'font-medium text-foreground' : 'text-foreground/80',
                  )}>
                    {model.modelName}
                  </span>
                  {selected && <Check className="size-3.5 shrink-0 text-blue-500" />}
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                    {index + 1}
                  </span>
                </button>
              )
            })}
            {models.length === 0 && (
              <p className="px-2 py-5 text-center text-[13px] text-muted-foreground">
                {loading ? t('model.loading') : t('model.empty')}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {effortLevel && (
        <Popover open={effortOpen} onOpenChange={setEffortOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('effort.levelAria', { level: t(EFFORT_LABEL_KEYS[effortLevel]) })}
              aria-expanded={effortOpen}
              className="flex h-7 shrink-0 items-center rounded-md px-1 transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="text-[13px] text-foreground/80">{t(EFFORT_LABEL_KEYS[effortLevel])}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={8}
            aria-label={t('effort.level')}
            className="border-0 bg-transparent p-0 shadow-none"
          >
            <AgentThinkingEffortControl
              key={`${selectedModel?.channelId}:${selectedModel?.modelId}`}
              capability={capability}
              value={effortLevel}
              onValueChange={onEffortChange}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
