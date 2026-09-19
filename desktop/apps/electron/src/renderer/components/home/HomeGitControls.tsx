import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, ChevronDown, GitBranch, GitFork, Loader2 } from 'lucide-react'
import type { AgentWorkspace, GitBranchInfo } from '@proma/shared'
import { homeGitSelectionByWorkspaceAtom, updateHomeGitSelection } from '@/atoms/home-git'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

interface HomeGitControlsProps {
  workspaces: AgentWorkspace[]
  workspaceId: string | null
  /** Git 上下文已经明确；false 时主页不得创建可能落入错误目录的 Code 会话。 */
  onReadyChange?: (ready: boolean) => void
}

export function HomeGitControls({ workspaces, workspaceId, onReadyChange }: HomeGitControlsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [selections, setSelections] = useAtom(homeGitSelectionByWorkspaceAtom)
  const [repoBranch, setRepoBranch] = React.useState<string | null>(null)
  const [branches, setBranches] = React.useState<GitBranchInfo[]>([])
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const workspacePath = workspace ? (workspace.canonicalPath || workspace.path) : undefined
  const selection = workspaceId ? selections.get(workspaceId) : undefined
  const selectedBranch = selection?.baseBranch || repoBranch
  const useWorktree = selection?.useWorktree ?? false

  React.useEffect(() => {
    setRepoBranch(null)
    setBranches([])
    setOpen(false)
    if (!workspaceId || !workspacePath) {
      onReadyChange?.(true)
      return
    }
    onReadyChange?.(false)
    let cancelled = false
    void window.electronAPI.getGitRepoStatus(workspacePath).then((status) => {
      if (cancelled) return
      if (status?.isRepo !== true) {
        onReadyChange?.(true)
        return
      }
      if (!status.branch) return
      setRepoBranch(status.branch)
      setSelections((current) => {
        return current.has(workspaceId)
          ? current
          : updateHomeGitSelection(current, workspaceId, { baseBranch: status.branch! }, status.branch!)
      })
      onReadyChange?.(true)
    }).catch((error: unknown) => {
      console.warn('[主页 Git] 读取项目分支失败:', error)
    })
    return () => { cancelled = true }
  }, [onReadyChange, setSelections, workspaceId, workspacePath])

  React.useEffect(() => {
    if (!open || !workspacePath) return
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    void window.electronAPI.listGitBranches(workspacePath).then((result) => {
      if (!cancelled) setBranches(result.branches)
    }).catch((error: unknown) => {
      console.warn('[主页 Git] 读取分支列表失败:', error)
      if (!cancelled) {
        setBranches([])
        setLoadFailed(true)
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, workspacePath])

  if (!workspaceId || !workspacePath || !selectedBranch) return null

  const selectBranch = (branch: string): void => {
    setSelections((current) => updateHomeGitSelection(current, workspaceId, { baseBranch: branch }, selectedBranch))
    setOpen(false)
  }

  const toggleWorktree = (): void => {
    setSelections((current) => updateHomeGitSelection(
      current,
      workspaceId,
      { useWorktree: !useWorktree },
      selectedBranch,
    ))
  }

  return (
    <div className="inline-flex h-6 shrink-0 items-center rounded-full border border-black/[0.08] bg-card text-xs text-foreground/80">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('git.switchBranch')}
            className="inline-flex h-full max-w-[220px] items-center gap-1.5 rounded-l-full px-2.5 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <GitBranch className="size-3 shrink-0 text-foreground/55" />
            <span className="truncate">{selectedBranch}</span>
            <ChevronDown className="size-3 shrink-0 text-foreground/45" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="w-64 rounded-xl p-1.5">
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
            {t('git.branches')}
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('git.loadingBranches')}
            </div>
          ) : loadFailed || branches.length === 0 ? (
            <div className="px-3 py-5 text-center text-xs text-muted-foreground">
              {t(loadFailed ? 'git.loadFailed' : 'git.noBranch')}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto overscroll-contain">
              {branches.map((branch) => {
                const selected = branch.name === selectedBranch
                return (
                  <button
                    key={branch.name}
                    type="button"
                    onClick={() => selectBranch(branch.name)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent/75',
                      selected && 'bg-accent/55 font-medium',
                    )}
                  >
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    {selected && <Check className="size-3.5 shrink-0" />}
                  </button>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <span className="h-3.5 w-px bg-border/75" />
      <button
        type="button"
        role="checkbox"
        aria-checked={useWorktree}
        onClick={toggleWorktree}
        className="inline-flex h-full items-center gap-1.5 rounded-r-full px-2.5 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <GitFork className="size-3 shrink-0 text-foreground/55" />
        <span
          aria-hidden="true"
          className={cn(
            'flex size-3 items-center justify-center rounded-[3px] border transition-colors',
            useWorktree ? 'border-blue-500 bg-blue-500 text-white' : 'border-foreground/25 bg-card',
          )}
        >
          {useWorktree && <Check className="size-2.5" strokeWidth={3} />}
        </span>
        <span>worktree</span>
      </button>
    </div>
  )
}
