/**
 * PermissionModeSelector — Agent 权限模式切换器
 *
 * 集成在 Agent 输入区中，以文字触发器 + 选择面板切换模式。
 * 每个会话独立维护自己的权限模式。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  agentPermissionModeMapAtom,
  agentDefaultPermissionModeAtom,
  sessionPersistedPermissionModeAtom,
  sessionExistsAtom,
} from '@/atoms/agent-atoms'
import type { PromaApprovalMode, PromaPermissionMode } from '@proma/shared'
import { PROMA_PERMISSION_MODE_CONFIG } from '@proma/shared'
import {
  getAutoModeAvailability,
  getVisibleApprovalModes,
  normalizeApprovalMode,
} from '@/lib/agent-plan-mode'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { cn } from '@/lib/utils'
import { useTranslation, type TranslationKey } from '@/lib/i18n'

/** 触发器使用短标签，弹层展示当前语言下的说明。 */
const TRIGGER_LABEL_KEYS: Record<PromaApprovalMode, TranslationKey> = {
  default: 'permission.manual',
  acceptEdits: 'permission.acceptEdits',
  dontAsk: 'permission.dontAsk',
  bypassPermissions: 'permission.bypass',
  auto: 'permission.auto',
}

interface PermissionModeSelectorProps {
  sessionId: string
  planModeEnabled?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  /** 当前模型由 Runtime 目录声明支持 Auto 时才开放。 */
  supportsAutoMode?: boolean
}

export interface PermissionModeOptionRow {
  key: string
  label: string
  description: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}

export function PermissionModeOption({
  row,
  index,
}: {
  row: PermissionModeOptionRow
  index: number
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={row.disabled}
      aria-disabled={row.disabled}
      onClick={row.onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
        'hover:bg-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        row.disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{row.label}</span>
        <span className="block text-xs text-muted-foreground">{row.description}</span>
      </span>
      {row.selected && <Check className="size-3.5 shrink-0 text-blue-500" />}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
        {index + 1}
      </span>
    </button>
  )
}

export function PermissionModeSelector({
  sessionId,
  planModeEnabled = false,
  onPlanModeChange,
  supportsAutoMode = false,
}: PermissionModeSelectorProps): React.ReactElement | null {
  const { language, t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [modeMap, setModeMap] = useAtom(agentPermissionModeMapAtom)
  const defaultMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedSessionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const allowBypass = useAtomValue(settingsPreferencesAtom).allowBypassPermissionsMode
  const mode = normalizeApprovalMode(modeMap.get(sessionId) ?? persistedSessionMode ?? defaultMode)
  const sessionExistsInList = useAtomValue(sessionExistsAtom(sessionId))
  const autoModeAvailability = getAutoModeAvailability(supportsAutoMode)

  // 初始化：如果当前 session 不在 Map 中，按以下优先级读回：
  // 1. session meta.permissionMode（每个 tab 独立持久化，重启恢复各自的值）
  // 2. 默认手动审批模式
  // 注意：只写入当前 session，不回写到 agentDefaultPermissionModeAtom，避免跨会话污染。
  React.useEffect(() => {
    if (!sessionExistsInList) return

    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      if (prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.set(sessionId, normalizeApprovalMode(persistedSessionMode ?? defaultMode))
      return next
    })
  }, [sessionId, persistedSessionMode, sessionExistsInList, defaultMode, setModeMap])

  /** 切换当前会话的权限模式 */
  const selectMode = React.useCallback(async (nextMode: PromaApprovalMode) => {
    if (nextMode === 'auto' && autoModeAvailability !== 'supported') return
    if (planModeEnabled) onPlanModeChange?.(false)
    if (nextMode === mode) {
      setOpen(false)
      return
    }
    const prevMode = mode

    // 乐观更新当前 session 的模式
    setModeMap((prev: Map<string, PromaPermissionMode>) => {
      const next = new Map(prev)
      next.set(sessionId, nextMode)
      return next
    })

    // 热切换运行中的当前 session；失败时回滚 modeMap 保持 UI/后端一致
    try {
      await window.electronAPI.updateSessionPermissionMode(sessionId, nextMode)
      setOpen(false)
    } catch (error) {
      console.error('[PermissionModeSelector] 运行中切换权限模式失败，回滚 UI:', error)
      setModeMap((prev: Map<string, PromaPermissionMode>) => {
        const next = new Map(prev)
        next.set(sessionId, prevMode)
        return next
      })
    }
  }, [mode, sessionId, setModeMap, planModeEnabled, onPlanModeChange, autoModeAvailability])

  /** 菜单行按 Runtime 原生权限模式排列，计划模式保持独立开关。 */
  const approvalRow = (nextMode: PromaApprovalMode): PermissionModeOptionRow => ({
    key: nextMode,
    label: t(TRIGGER_LABEL_KEYS[nextMode]),
    description: nextMode === 'auto' && autoModeAvailability !== 'supported'
      ? t(autoModeAvailability === 'checking'
        ? 'permission.autoChecking'
        : 'permission.autoUnavailable')
      : language === 'zh'
      ? PROMA_PERMISSION_MODE_CONFIG[nextMode].description
      : nextMode === 'default'
        ? 'Ask before running tools or making changes.'
        : nextMode === 'acceptEdits'
          ? 'Allow file edits while asking before other actions.'
          : nextMode === 'dontAsk'
            ? 'Deny actions that need additional approval.'
            : nextMode === 'auto'
              ? 'Let the runtime decide when approval is needed.'
              : 'Allow all actions without asking.',
    selected: nextMode === mode && !planModeEnabled,
    disabled: nextMode === 'auto' && autoModeAvailability !== 'supported',
    onSelect: () => void selectMode(nextMode),
  })
  const approvalRows = getVisibleApprovalModes({ allowBypass }).map(approvalRow)
  const rows: PermissionModeOptionRow[] = [
    ...approvalRows.slice(0, 3),
    ...(onPlanModeChange
      ? [{
          key: 'plan',
          label: t('agent.plan'),
          description: language === 'zh' ? '先制定计划，再执行改动' : 'Create a plan before making changes.',
          selected: planModeEnabled,
          disabled: false,
          onSelect: () => { onPlanModeChange(!planModeEnabled); setOpen(false) },
        }]
      : []),
    ...approvalRows.slice(3),
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t('home.permissionMode')}：${planModeEnabled ? t('agent.plan') : t(TRIGGER_LABEL_KEYS[mode])}`}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-[#3B3B3A] dark:text-foreground/80',
            'transition-colors hover:bg-accent/55 hover:text-foreground',
            'data-[state=open]:bg-accent/55 data-[state=open]:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <span>{planModeEnabled ? t('agent.plan') : t(TRIGGER_LABEL_KEYS[mode])}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[280px] rounded-xl p-1.5"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
          {language === 'zh' ? '模式' : 'Mode'}
        </div>
        {/* 权限模式按 Runtime 原生顺序展示；计划模式保持独立入口。 */}
        {rows.map((row, index) => (
          <PermissionModeOption key={row.key} row={row} index={index} />
        ))}
      </PopoverContent>
    </Popover>
  )
}
