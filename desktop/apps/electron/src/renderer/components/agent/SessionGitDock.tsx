/**
 * SessionGitDock — 输入区上方的 Git 状态条（对齐参考截图）
 *
 * 灰色横条：左侧仓库与分支（可切换），右侧未暂存变更统计与操作按钮。
 * - 变更统计可点击 → 打开右侧 Changes 面板；悬停显示「View diff」提示
 * - 主操作：有未推送提交时为 Create PR，否则 Commit changes（指令发给 AI）
 * - 主按钮旁的 ChevronDown 仅更换操作，点击主按钮才发送
 * - 右侧 X 关闭整条坞（进程内记忆，重启恢复）
 * 仅当会话工作目录是 Git 仓库时显示；数据复用 useSessionGitSummary 缓存。
 */

import * as React from 'react'
import { atom, useAtom, useSetAtom } from 'jotai'
import { Check, ChevronDown, X } from 'lucide-react'
import { agentGitDockDismissedAtom, openAgentSidePanelTabAtom } from '@/atoms/agent-atoms'
import { useSessionGitSummary } from '@/hooks/useSessionGitSummary'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SessionGitBranchMenu } from './SessionGitBranchMenu'
import { useTranslation } from '@/lib/i18n'

interface SessionGitDockProps {
  sessionId: string
  sessionPath: string | null
  /** 点击 Commit changes 时把提交指令发送给 AI */
  onCommitRequest: () => void
  /** 点击 Create PR 时把 PR 指令发送给 AI */
  onCreatePrRequest: () => void
}

/** 从工作目录路径提取仓库名（兼容 POSIX 与 Windows 分隔符） */
function repoDisplayName(dirPath: string): string {
  const parts = dirPath.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? dirPath
}

/** 按会话记住手动选择；选择动作不触发模型请求。 */
const gitDockActionAtom = atom(new Map<string, 'pr' | 'commit'>())

const dockButtonClass =
  'flex h-6 shrink-0 items-center whitespace-nowrap rounded-md bg-card px-2 text-[11px] font-medium text-foreground/80 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50'

export function SessionGitDock({ sessionId, sessionPath, onCommitRequest, onCreatePrRequest }: SessionGitDockProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { gitSummary, applyBranchChange } = useSessionGitSummary(sessionId, sessionPath)
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const [dismissed, setDismissed] = useAtom(agentGitDockDismissedAtom)
  const [selectedActions, setSelectedActions] = useAtom(gitDockActionAtom)

  const repoStatus = gitSummary?.repoStatus
  if (!sessionPath || !gitSummary || repoStatus?.isRepo !== true) return null
  if (dismissed.has(sessionId)) return null

  const hasChanges = gitSummary.filesChanged > 0 || gitSummary.additions > 0 || gitSummary.deletions > 0
  // 对齐参考：有未推送提交时主操作为 Create PR，否则 Commit changes
  const canCreatePr = (repoStatus.aheadCount ?? 0) > 0
  const primaryAction = selectedActions.get(sessionId) ?? (canCreatePr ? 'pr' : 'commit')
  const selectAction = (action: 'pr' | 'commit'): void => {
    setSelectedActions((previous) => new Map(previous).set(sessionId, action))
  }

  const handleDismiss = (): void => {
    setDismissed((prev: Set<string>) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }

  return (
    <div
      className="mb-1.5 flex h-10 shrink-0 items-center gap-1 rounded-[10px] bg-foreground/[0.045] px-2.5"
      data-session-git-dock
    >
      <span className="ml-0.5 min-w-0 max-w-[180px] truncate text-[13px] text-muted-foreground">
        {repoDisplayName(sessionPath)}
      </span>
      <SessionGitBranchMenu
        dirPath={sessionPath}
        sessionId={sessionId}
        currentBranch={repoStatus.branch}
        onBranchChanged={applyBranchChange}
        triggerClassName="-ml-0.5"
      />

      <div className="ml-auto flex items-center gap-1.5">
        {hasChanges && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('git.viewChanges')}
                onClick={() => openSidePanelTab({ sessionId, tab: 'changes' })}
                className={`${dockButtonClass} gap-1 tabular-nums`}
              >
                {gitSummary.additions > 0 && (
                  <span className="text-[#1E9E3C]">+{gitSummary.additions.toLocaleString()}</span>
                )}
                {gitSummary.additions > 0 && gitSummary.deletions > 0 && (
                  <span className="text-foreground/25">·</span>
                )}
                {gitSummary.deletions > 0 && (
                  <span className="text-[#CD2054]">-{gitSummary.deletions.toLocaleString()}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{t('git.viewDiff')}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* 主操作 + 备选操作下拉（对齐参考 Create PR ⌄ 结构） */}
        <div className="flex items-center gap-px">
          <button
            type="button"
            disabled={primaryAction === 'pr' ? !canCreatePr : !hasChanges}
            onClick={primaryAction === 'pr' ? onCreatePrRequest : onCommitRequest}
            className={`${dockButtonClass} rounded-r-none`}
          >
            {primaryAction === 'pr' ? t('git.createPr') : t('git.commitChanges')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('git.moreActions')}
                className={`${dockButtonClass} rounded-l-none px-1`}
              >
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-44">
              <DropdownMenuItem
                onSelect={() => selectAction('pr')}
              >
                {t('git.createPr')}
                {primaryAction === 'pr' && <Check className="ml-auto size-3.5 text-foreground/60" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => selectAction('commit')}
              >
                {t('git.commitChanges')}
                {primaryAction === 'commit' && <Check className="ml-auto size-3.5 text-foreground/60" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <button
          type="button"
          aria-label={t('git.closeDock')}
          title={t('dialog.close')}
          onClick={handleDismiss}
          className="flex size-6 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
