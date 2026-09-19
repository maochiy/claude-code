/**
 * SessionMoreMenu — 会话工具行右侧的「更多」入口（参考截图 7）
 *
 * 触发器 = 模型名 + 当前档位徽章 + 上下文用量圆环（与参考图 7 底部工具行一致）；
 * 点击弹出菜单：模型 / 思考等级 / 审批模式三个子视图 + 添加附件 / 计划 / 语音输入。
 * 原工具行的并列触发器（AgentModelEffortControl / PermissionModeSelector / AgentInputAddMenu /
 * SpeechButton）全部收进此菜单，工具行只保留终端图标 + 更多（+ 发送/停止）。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check, ChevronLeft, ChevronRight, FilePlus2, Lightbulb, Mic } from 'lucide-react'
import type { ModelOption, PromaApprovalMode, PromaPermissionMode, ThinkingEffortLevel } from '@proma/shared'
import { PROMA_PERMISSION_MODE_CONFIG } from '@proma/shared'
import {
  agentPermissionModeMapAtom,
  agentDefaultPermissionModeAtom,
  sessionPersistedPermissionModeAtom,
  sessionExistsAtom,
} from '@/atoms/agent-atoms'
import { THINKING_EFFORT_LABELS, type AgentThinkingEffortCapability } from '@/lib/agent-thinking-effort'
import {
  getAutoModeAvailability,
  getVisibleApprovalModes,
  normalizeApprovalMode,
} from '@/lib/agent-plan-mode'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { startVoiceDictation } from '@/components/ai-elements/speech-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'
import { EffortBadge } from '@/components/home/HomeEffortCard'
import { UsageRing } from './ContextUsageBadge'
import { useTranslation } from '@/lib/i18n'

type MoreMenuView = 'root' | 'model' | 'effort' | 'permission'

/** 触发器/菜单行展示的英文短词（参考截图为英文界面） */
const APPROVAL_TRIGGER_LABELS: Record<PromaApprovalMode, string> = {
  default: 'Manual',
  acceptEdits: 'Accept edits',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
  auto: 'Auto',
}

interface SessionMoreMenuProps {
  sessionId: string
  models: ModelOption[]
  selectedModel: { channelId: string; modelId: string } | null
  loading: boolean
  modelSwitchDisabled: boolean
  capability: AgentThinkingEffortCapability | null
  effortLevel?: ThinkingEffortLevel
  onModelSelect: (model: ModelOption) => void
  onModelListOpen?: () => void
  onEffortChange: (level: ThinkingEffortLevel) => void
  /** 上下文用量圆环（0-1）与告警态 */
  usageRatio: number
  usageWarning: boolean
  onAttachFile: () => void
  planModeEnabled: boolean
  onPlanModeChange: (enabled: boolean) => void
}

/** 菜单行：左文案 + 右当前值/chevron（子视图入口） */
function MenuRow({ label, value, onClick }: {
  label: string
  value?: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/85',
        'transition-colors duration-100 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {value && <span className="max-w-[130px] truncate text-[12px] text-muted-foreground">{value}</span>}
      <ChevronRight className="size-3.5 shrink-0 text-foreground/30" />
    </button>
  )
}

/** 动作行：图标 + 文案（可选选中态） */
function MenuActionRow({ icon, label, selected, onClick }: {
  icon: React.ReactNode
  label: string
  selected?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/85',
        'transition-colors duration-100 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center text-foreground/60">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check className="size-3.5 shrink-0 text-foreground/60" />}
    </button>
  )
}

/** 计划模式开关始终可用，与是否已经生成计划文档无关。 */
export function SessionPlanModeAction({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}): React.ReactElement {
  return (
    <MenuActionRow
      icon={<Lightbulb className="size-4" />}
      label="计划"
      selected={enabled}
      onClick={() => onChange(!enabled)}
    />
  )
}

export function SessionMoreMenu({
  sessionId,
  models,
  selectedModel,
  loading,
  modelSwitchDisabled,
  capability,
  effortLevel,
  onModelSelect,
  onModelListOpen,
  onEffortChange,
  usageRatio,
  usageWarning,
  onAttachFile,
  planModeEnabled,
  onPlanModeChange,
}: SessionMoreMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<MoreMenuView>('root')
  const listRef = React.useRef<HTMLDivElement>(null)
  const refreshedForOpenRef = React.useRef(false)

  // 会话权限模式（与 PermissionModeSelector 同一套数据源与初始化规则）
  const [modeMap, setModeMap] = useAtom(agentPermissionModeMapAtom)
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const sessionExistsInList = useAtomValue(sessionExistsAtom(sessionId))
  const allowBypass = useAtomValue(settingsPreferencesAtom).allowBypassPermissionsMode
  const approvalMode = normalizeApprovalMode(
    modeMap.get(sessionId) ?? persistedSessionMode ?? defaultMode,
  )

  // 初始化：session 不在 Map 中时按「持久化值 ?? 全局默认」写入（只写当前会话）
  React.useEffect(() => {
    if (!sessionExistsInList) return
    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      if (prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.set(sessionId, normalizeApprovalMode(persistedSessionMode ?? defaultMode))
      return next
    })
  }, [sessionId, persistedSessionMode, sessionExistsInList, defaultMode, setModeMap])

  const currentModel = models.find(model =>
    model.channelId === selectedModel?.channelId && model.modelId === selectedModel?.modelId,
  ) ?? models.find(model =>
    model.channelId === selectedModel?.channelId
    && model.modelId === selectedModel?.modelId.replace(/\[1m\]$/i, ''),
  )
  const modelName = currentModel?.modelName || selectedModel?.modelId || '选择模型'
  const autoModeAvailability = getAutoModeAvailability(
    currentModel?.runtimeModelInfo?.supportsAutoMode,
  )

  // 同一次打开只刷新一次模型目录；回到根视图
  React.useEffect(() => {
    if (!open) {
      refreshedForOpenRef.current = false
      setView('root')
      return
    }
    if (!refreshedForOpenRef.current) {
      refreshedForOpenRef.current = true
      onModelListOpen?.()
    }
  }, [open, onModelListOpen])

  /** 子视图内方向键导航 */
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

  /** 关闭后延迟执行动作（避免 popover 关闭动画吞掉文件对话框） */
  const runAfterClose = (action: () => void): void => {
    setOpen(false)
    requestAnimationFrame(action)
  }

  /** 切换当前会话权限模式（乐观更新 + 失败回滚，对齐 PermissionModeSelector） */
  const selectApprovalMode = React.useCallback(async (nextMode: PromaApprovalMode): Promise<void> => {
    if (nextMode === 'auto' && autoModeAvailability !== 'supported') return
    const prevMode = approvalMode
    if (nextMode === prevMode) {
      setView('root')
      return
    }
    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      const next = new Map(prev)
      next.set(sessionId, nextMode)
      return next
    })
    try {
      await window.electronAPI.updateSessionPermissionMode(sessionId, nextMode)
      setView('root')
    } catch (error) {
      console.error('[SessionMoreMenu] 运行中切换权限模式失败，回滚 UI:', error)
      setModeMap((prev: Map<string, PromaPermissionMode>) => {
        const next = new Map(prev)
        next.set(sessionId, prevMode)
        return next
      })
    }
  }, [approvalMode, sessionId, setModeMap, autoModeAvailability])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`更多：${modelName}${effortLevel ? ` · ${THINKING_EFFORT_LABELS[effortLevel]}` : ''}`}
          aria-expanded={open}
          className={cn(
            'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 transition-colors',
            'hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'data-[state=open]:bg-accent/55',
          )}
        >
          <span className="max-w-[160px] truncate text-[13px] text-foreground/80">{modelName}</span>
          {effortLevel && <EffortBadge level={effortLevel} />}
          <UsageRing ratio={usageRatio} isWarning={usageWarning} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label="更多设置"
        className={cn(
          'rounded-[10px] p-1.5',
          view === 'model' ? 'w-[240px]' : view === 'effort' ? 'w-auto' : 'w-64',
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {view === 'root' && (
          <div className="flex flex-col">
            <MenuRow label="模型" value={modelName} onClick={() => setView('model')} />
            {effortLevel && (
              <MenuRow
                label="思考等级"
                value={THINKING_EFFORT_LABELS[effortLevel]}
                onClick={() => setView('effort')}
              />
            )}
            <MenuRow
              label="审批模式"
              value={APPROVAL_TRIGGER_LABELS[approvalMode]}
              onClick={() => setView('permission')}
            />
            <div className="mx-1 my-1 h-px bg-border/60" />
            <MenuActionRow
              icon={<FilePlus2 className="size-4" />}
              label="添加附件"
              onClick={() => runAfterClose(onAttachFile)}
            />
            <SessionPlanModeAction
              enabled={planModeEnabled}
              onChange={(enabled) => runAfterClose(() => onPlanModeChange(enabled))}
            />
            <MenuActionRow
              icon={<Mic className="size-4" />}
              label="语音输入"
              onClick={() => runAfterClose(() => void startVoiceDictation())}
            />
          </div>
        )}

        {view === 'model' && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setView('root')}
              className="mb-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronLeft className="size-3.5" />
              返回
            </button>
            <div className="px-2 pb-1 pt-0.5 text-[12px] leading-4 text-muted-foreground">Models</div>
            {modelSwitchDisabled && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">任务完成后可切换模型</p>
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
                      setOpen(false)
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
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                      {index + 1}
                    </span>
                  </button>
                )
              })}
              {models.length === 0 && (
                <p className="px-2 py-5 text-center text-[13px] text-muted-foreground">
                  {loading ? '加载模型…' : '暂无可用模型'}
                </p>
              )}
            </div>
          </div>
        )}

        {view === 'effort' && effortLevel && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setView('root')}
              className="mb-1 flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronLeft className="size-3.5" />
              返回
            </button>
            <AgentThinkingEffortControl
              key={`${selectedModel?.channelId}:${selectedModel?.modelId}`}
              capability={capability}
              value={effortLevel}
              onValueChange={onEffortChange}
            />
          </div>
        )}

        {view === 'permission' && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setView('root')}
              className="mb-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronLeft className="size-3.5" />
              返回
            </button>
            <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">审批模式</div>
            {getVisibleApprovalModes({ allowBypass }).map((nextMode) => {
              const nextConfig = PROMA_PERMISSION_MODE_CONFIG[nextMode]
              const selected = nextMode === approvalMode
              const autoUnavailable = nextMode === 'auto' && autoModeAvailability !== 'supported'
              return (
                <button
                  key={nextMode}
                  type="button"
                  disabled={autoUnavailable}
                  aria-disabled={autoUnavailable}
                  onClick={() => void selectApprovalMode(nextMode)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                    'hover:bg-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    selected && 'bg-accent/55',
                    autoUnavailable && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {nextConfig.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {autoUnavailable
                        ? t(autoModeAvailability === 'checking'
                          ? 'permission.autoChecking'
                          : 'permission.autoUnavailable')
                        : nextConfig.description}
                    </span>
                  </span>
                  {selected && <Check className="size-4 shrink-0 text-foreground/65" />}
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
