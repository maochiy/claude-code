/**
 * DiffChangesList — 代码改动文件列表
 *
 * 显示当前工作树相对 HEAD 的代码改动，按目录分组，支持 hover 操作按钮。
 */

import * as React from 'react'
import { ChevronRight, Search, Undo2, X } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { agentDiffUnseenFilesAtom, agentDiffDataAtom, agentSelectedWorktreeAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import type { ChangedFileEntry, ChangeSource, UntrackedFileEntry, WorktreeInfo } from '@proma/shared'
import { WorktreeSelector } from './WorktreeSelector'
import { InlineFileDiff } from './InlineFileDiff'
import { useTranslation } from '@/lib/i18n'
import { getWorktreeDiffContext } from '@/lib/worktree-diff-context'

/** 按目录分组后的数据结构 */
interface FileGroup {
  /** 完整 Git 仓库路径（用作 React key，避免同名目录冲突） */
  gitRoot: string
  /** 显示用的目录名（仓库的最后一段） */
  dirName: string
  files: ChangedFileEntry[]
  totalAdditions: number
  totalDeletions: number
  sources: ChangeSource[]
}

interface DiffChangesListProps {
  /** Git 仓库根目录 */
  dirPath: string
  /** 当前 Agent 会话 ID，用于主进程路径授权 */
  sessionId: string
  /** 会话工作目录（用于 badge 计算） */
  sessionPath?: string
  /** 工作区共享文件目录（用于 badge 计算） */
  workspaceFilesPath?: string
  /** 自动刷新信号（版本号递增触发） */
  refreshVersion?: number
  /** 额外的候选目录（附加目录等） */
  extraPaths?: string[]
  /** 工作区 slug，用于 WorktreeSelector 拉取 worktree 列表 */
  workspaceSlug?: string
  /** 用于自动发现 worktree 的仓库候选路径 */
  worktreeRepoPaths?: string[]
}

export const DiffChangesList = React.memo(function DiffChangesList({
  dirPath,
  sessionPath,
  sessionId,
  workspaceFilesPath,
  refreshVersion,
  extraPaths,
  workspaceSlug,
  worktreeRepoPaths,
}: DiffChangesListProps): React.ReactElement {
  const { language } = useTranslation()
  // Worktree 选择状态（内联 WorktreeSelector）
  const selectedWorktreeMap = useAtomValue(agentSelectedWorktreeAtom)
  const setSelectedWorktreeMap = useSetAtom(agentSelectedWorktreeAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const selectedWorktreePath = selectedWorktreeMap.get(sessionId) ?? null
  const session = agentSessions.find((candidate) => candidate.id === sessionId)
  const worktreeMode = React.useMemo(
    () => getWorktreeDiffContext(session, selectedWorktreePath),
    [selectedWorktreePath, session],
  )
  const diffCacheKey = worktreeMode
    ? `${sessionId}:worktree:${worktreeMode.path}:base:${worktreeMode.baseBranch}`
    : `${sessionId}:session`
  const handleWorktreeSelect = React.useCallback((worktree: WorktreeInfo | null) => {
    setSelectedWorktreeMap((prev) => {
      const m = new Map(prev)
      m.set(sessionId, worktree?.path ?? null)
      return m
    })
  }, [sessionId, setSelectedWorktreeMap])

  // Diff 数据缓存：mount 时若已有上次结果，立即用作初值，避免空数组闪 1s "没有代码改动"
  const diffDataMap = useAtomValue(agentDiffDataAtom)
  const setDiffDataMap = useSetAtom(agentDiffDataAtom)
  const cached = diffDataMap.get(diffCacheKey)
  const [files, setFiles] = React.useState<ChangedFileEntry[]>(() => cached?.files ?? [])
  const [untrackedFiles, setUntrackedFiles] = React.useState<UntrackedFileEntry[]>(() => cached?.untrackedFiles ?? [])
  const [isGitRepo, setIsGitRepo] = React.useState(() => cached?.isGitRepo ?? true)
  /** 首次 fetch 是否已返回——区分 loading 与真·空，避免 "没有代码改动" 误闪 */
  const [hasFetched, setHasFetched] = React.useState<boolean>(() => cached !== undefined)
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(new Set())
  /** 单调递增的 fetch 序号，用于丢弃乱序到达的旧响应 */
  const fetchSeqRef = React.useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset state on cache key switch, not on every diffDataMap update
  React.useEffect(() => {
    fetchSeqRef.current += 1
    const nextCached = diffDataMap.get(diffCacheKey)
    setFiles(nextCached?.files ?? [])
    setUntrackedFiles(nextCached?.untrackedFiles ?? [])
    setIsGitRepo(nextCached?.isGitRepo ?? true)
    setHasFetched(nextCached !== undefined)
    setExpandedFiles(new Set())
  }, [diffCacheKey])

  // Agent 本轮刚修改但尚未查看的文件
  const unseenFilesMap = useAtomValue(agentDiffUnseenFilesAtom)
  const setUnseenFilesMap = useSetAtom(agentDiffUnseenFilesAtom)
  const unseenFiles = unseenFilesMap.get(sessionId) ?? new Set<string>()

  const markFileAsSeen = React.useCallback((filePath: string) => {
    setUnseenFilesMap((prev) => {
      const s = prev.get(sessionId)
      if (!s?.has(filePath)) return prev
      const m = new Map(prev)
      const next = new Set(s)
      next.delete(filePath)
      m.set(sessionId, next)
      return m
    })
  }, [sessionId, setUnseenFilesMap])

  const fetchChanges = React.useCallback(async () => {
    if (!dirPath && !worktreeMode) return
    const requestId = ++fetchSeqRef.current
    try {
      const result = worktreeMode
        ? await window.electronAPI.getWorktreeChanges(worktreeMode.path, worktreeMode.baseBranch, sessionId)
        : await window.electronAPI.getUnstagedChanges(dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId)
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(result.isGitRepo)
      setFiles(result.files || [])
      setUntrackedFiles(result.untrackedFiles || [])
      setHasFetched(true)
      setDiffDataMap((prev) => {
        const next = new Map(prev)
        next.set(diffCacheKey, result)
        return next
      })
    } catch {
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(true)
      setHasFetched(true)
    }
  }, [dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId, setDiffDataMap, worktreeMode, diffCacheKey])

  React.useEffect(() => {
    fetchChanges()
  }, [fetchChanges, refreshVersion])

  // 窗口聚焦刷新已统一在 useGlobalAgentListeners 中处理（递增 refreshVersion）

  /** Revert 文件 */
  const handleRevert = React.useCallback(async (filePath: string, gitRoot: string) => {
    const confirmed = window.confirm(language === 'zh'
      ? `确定要还原 ${filePath} 的所有变更吗？此操作不可撤销。`
      : `Revert all changes to ${filePath}? This action cannot be undone.`)
    if (!confirmed) return
    try {
      await window.electronAPI.revertFile({ dirPath, filePath, gitRoot, sessionId })
      await fetchChanges()
    } catch (err) {
      const fallback = language === 'zh' ? '未知错误' : 'Unknown error'
      window.alert(language === 'zh'
        ? `还原失败：${err instanceof Error ? err.message : fallback}`
        : `Failed to revert: ${err instanceof Error ? err.message : fallback}`)
    }
  }, [dirPath, fetchChanges, language, sessionId])

  /** 切换文件夹折叠 */
  const toggleDir = React.useCallback((dirName: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirName)) {
        next.delete(dirName)
      } else {
        next.add(dirName)
      }
      return next
    })
  }, [])

  const toggleFile = React.useCallback((fileKey: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(fileKey)) next.delete(fileKey)
      else next.add(fileKey)
      return next
    })
  }, [])

  // 按 Git 仓库分组（在所有 hooks 之后、条件返回之前调用）
  const { fileGroups, matchedFilesCount } = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    // 用完整 gitRoot 做 key，避免同名目录冲突
    const groups = new Map<string, ChangedFileEntry[]>()
    let matched = 0
    for (const f of files) {
      if (q && !f.filePath.toLowerCase().includes(q)) continue
      const key = f.gitRoot || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(f)
      matched++
    }
    const result: FileGroup[] = [...groups.entries()].map(([gitRoot, groupFiles]) => ({
      gitRoot,
      dirName: gitRoot ? gitRoot.split('/').pop() || gitRoot : '/',
      files: groupFiles,
      totalAdditions: groupFiles.reduce((sum, f) => sum + f.additions, 0),
      totalDeletions: groupFiles.reduce((sum, f) => sum + f.deletions, 0),
      sources: [...new Set(groupFiles.map((f) => f.source))],
    }))
    return { fileGroups: result, matchedFilesCount: matched }
  }, [files, searchQuery])

  const filteredUntrackedFiles = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return untrackedFiles
    return untrackedFiles.filter((f) => f.filePath.toLowerCase().includes(q))
  }, [untrackedFiles, searchQuery])

  const isEmpty = fileGroups.length === 0 && filteredUntrackedFiles.length === 0
  const hasAnyChanges = files.length > 0 || untrackedFiles.length > 0
  const shouldShowSearch = isGitRepo && (hasAnyChanges || searchQuery.length > 0)
  const shouldShowWorktreeSelector = Boolean(workspaceSlug || (worktreeRepoPaths?.length ?? 0) > 0)

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Worktree 分支选择器 — 空 diff / 非 Git 空态也保留，避免无法切到会话 worktree */}
      {shouldShowWorktreeSelector ? (
        <WorktreeSelector
          sessionId={sessionId}
          workspaceSlug={workspaceSlug}
          repoPaths={worktreeRepoPaths}
          selectedPath={selectedWorktreePath}
          onSelect={handleWorktreeSelect}
          trailing={shouldShowSearch ? (
            <button
              type="button"
              aria-label={language === 'zh' ? '搜索改动文件' : 'Search changed files'}
              onClick={() => setSearchOpen((open) => !open)}
              className={cn(
                'p-1 rounded transition-colors',
                searchOpen || searchQuery
                  ? 'text-foreground bg-accent/60'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Search className="w-3 h-3" />
            </button>
          ) : undefined}
        />
      ) : shouldShowSearch ? (
        <div className="flex h-8 items-center justify-end border-b border-border/50 px-2">
          <button
            type="button"
            aria-label={language === 'zh' ? '搜索改动文件' : 'Search changed files'}
            onClick={() => setSearchOpen((open) => !open)}
            className={cn(
              'p-1 rounded transition-colors',
              searchOpen || searchQuery
                ? 'text-foreground bg-accent/60'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Search className="w-3 h-3" />
          </button>
        </div>
      ) : null}

      {/* 搜索框 — 点击头部 🔍 图标后展开（对齐参考面板的 ⌘F 行为） */}
      {shouldShowSearch && searchOpen && (
        <div className="flex-shrink-0 bg-content-area px-2 pb-1 pt-1">
          <div className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-muted/50 border border-transparent focus-within:border-primary/40 focus-within:bg-muted/70 transition-colors">
            <Search className="size-3 text-muted-foreground flex-shrink-0" />
            <input
              type="text"
              aria-label={language === 'zh' ? '搜索改动文件' : 'Search changed files'}
              autoFocus
              className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
              placeholder={language === 'zh' ? '搜索改动文件...' : 'Search changed files...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false) }
              }}
            />
            {searchQuery && (
              <span className="text-[10px] text-muted-foreground/50 flex-shrink-0 tabular-nums">
                {matchedFilesCount + filteredUntrackedFiles.length}
              </span>
            )}
            <button
              type="button"
              aria-label={language === 'zh' ? '关闭搜索' : 'Close search'}
              className="flex-shrink-0 p-0.5 rounded-sm hover:bg-foreground/[0.08] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              onClick={() => { setSearchQuery(''); setSearchOpen(false) }}
            >
              <X className="size-3" />
            </button>
          </div>
        </div>
      )}

      {!isGitRepo && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">{language === 'zh' ? '当前目录不是 Git 仓库' : 'The current folder is not a Git repository'}</p>
        </div>
      )}
      {isGitRepo && !hasAnyChanges && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">
            {hasFetched
              ? (language === 'zh' ? '没有代码改动' : 'No file changes')
              : (language === 'zh' ? '加载中…' : 'Loading…')}
          </p>
        </div>
      )}
      {isGitRepo && hasAnyChanges && isEmpty && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">{language === 'zh' ? '没有匹配的文件' : 'No matching files'}</p>
        </div>
      )}
      {isGitRepo && hasAnyChanges && !isEmpty && (
        <div className="hover-scrollbar-xy min-h-0 min-w-0 flex-1">
          {fileGroups.map((group) => {
            const isCollapsed = collapsedDirs.has(group.gitRoot)
            return (
              <div key={group.gitRoot} className="min-w-full">
                {/* 文件夹 bar（对齐参考改动面板：紧凑单行、无彩色徽章） */}
                <button
                  type="button"
                  onClick={() => toggleDir(group.gitRoot)}
                  className="flex h-7 w-max min-w-full items-center gap-1 px-2 text-[11px] font-medium text-muted-foreground hover:bg-foreground/[0.04] transition-colors"
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
                  />
                  <span className="whitespace-nowrap">{group.dirName}</span>
                  <span className="ml-auto shrink-0 flex items-center gap-1.5 tabular-nums text-foreground/35">
                    <span>
                      {language === 'zh'
                        ? `${group.files.length} 个改动文件`
                        : `${group.files.length} changed ${group.files.length === 1 ? 'file' : 'files'}`}
                    </span>
                    {group.totalAdditions > 0 && <span>+{group.totalAdditions}</span>}
                    {group.totalDeletions > 0 && <span>-{group.totalDeletions}</span>}
                  </span>
                </button>

                {/* 文件列表 */}
                {!isCollapsed && group.files.map((file) => {
                  const absPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')
                  const fileKey = `tracked:${file.gitRoot}:${file.filePath}`
                  const isExpanded = expandedFiles.has(fileKey)
                  return (
                    <React.Fragment key={fileKey}>
                      <FileRow
                        file={file}
                        isExpanded={isExpanded}
                        isUnseen={unseenFiles.has(absPath)}
                        onClick={() => { markFileAsSeen(absPath); toggleFile(fileKey) }}
                        onRevert={() => handleRevert(file.filePath, file.gitRoot)}
                        dirPath={dirPath}
                        language={language}
                      />
                      {isExpanded && (
                        <InlineFileDiff
                          dirPath={dirPath}
                          filePath={file.filePath}
                          gitRoot={file.gitRoot}
                          sessionId={sessionId}
                          baseRef={worktreeMode?.baseBranch}
                          refreshVersion={refreshVersion}
                        />
                      )}
                    </React.Fragment>
                  )
                })}
              </div>
            )
          })}

          {/* 未追踪文件分组 */}
          {filteredUntrackedFiles.length > 0 && (
            <div className="min-w-full">
              <div className="flex h-7 items-center px-2 text-[11px] font-medium text-muted-foreground">
                {language === 'zh' ? '未追踪文件' : 'Untracked files'}
              </div>
              {filteredUntrackedFiles.map((file) => {
                const fileKey = `untracked:${file.gitRoot}:${file.filePath}`
                const isExpanded = expandedFiles.has(fileKey)
                return (
                  <React.Fragment key={fileKey}>
                    <UntrackedFileRow
                      file={file}
                      isExpanded={isExpanded}
                      language={language}
                      onClick={() => toggleFile(fileKey)}
                    />
                    {isExpanded && (
                      <InlineFileDiff
                        dirPath={dirPath}
                        filePath={file.filePath}
                        gitRoot={file.gitRoot}
                        sessionId={sessionId}
                        baseRef={worktreeMode?.baseBranch}
                        refreshVersion={refreshVersion}
                      />
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/** 已追踪文件的行 */
function FileRow({
  file,
  onClick,
  onRevert,
  isExpanded,
  isUnseen,
  dirPath,
  language,
}: {
  file: ChangedFileEntry
  onClick: () => void
  onRevert: () => void
  isExpanded: boolean
  isUnseen?: boolean
  dirPath: string
  language: 'zh' | 'en'
}): React.ReactElement {
  const parts = file.filePath.split('/')
  const fileName = parts.pop()!
  const dir = parts.join('/')
  const fullPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group flex h-[26px] w-full min-w-max items-center px-2 text-[12px] transition-colors',
        isExpanded
          ? 'bg-foreground/[0.055]'
          : 'hover:bg-foreground/[0.04]',
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onClick()
      }}
      aria-expanded={isExpanded}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
      </span>
      <FileTypeIcon name={fileName} isDirectory={false} size={13} />
      <Tooltip delayDuration={900}>
        <TooltipTrigger asChild>
          <span className="ml-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="shrink-0">
              {fileName}
              {isUnseen && <span className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle" />}
              {file.status === 'deleted' && (
                <span className="ml-1 text-foreground/30 text-[12px]">({language === 'zh' ? '已删除' : 'deleted'})</span>
              )}
            </span>
            {dir && (
              <span className="text-[11px] text-foreground/30 whitespace-nowrap">{dir}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all">{fullPath}</TooltipContent>
      </Tooltip>

      {/* +/- 行数 — hover 时隐藏让位给操作按钮 */}
      <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[11px] tabular-nums group-hover:hidden">
        {file.additions > 0 && (
          <span className="text-[#1E9E3C]">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-[#CD2054]">-{file.deletions}</span>
        )}
      </span>

      {/* Hover 操作按钮 */}
      <span className="ml-auto shrink-0 hidden group-hover:flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer"
              onClick={onRevert}
            >
              <Undo2 className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{language === 'zh' ? '还原文件变更' : 'Revert file changes'}</TooltipContent>
        </Tooltip>
      </span>
    </div>
  )
}

/** 未追踪文件的行 */
function UntrackedFileRow({
  file,
  onClick,
  isExpanded,
  language,
}: {
  file: UntrackedFileEntry
  onClick: () => void
  isExpanded: boolean
  language: 'zh' | 'en'
}): React.ReactElement {
  const filePath = file.filePath
  const parts = filePath.split('/')
  const fileName = parts.pop()!
  const dir = parts.join('/')
  const fullPath = `${file.gitRoot}/${file.filePath}`.replace(/\/+/g, '/')

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex h-[26px] w-full min-w-max items-center px-2 text-[12px] transition-colors',
        isExpanded ? 'bg-foreground/[0.055]' : 'hover:bg-foreground/[0.04]',
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onClick()
      }}
      aria-expanded={isExpanded}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
      </span>
      <FileTypeIcon name={fileName} isDirectory={false} size={13} />
      <Tooltip delayDuration={900}>
        <TooltipTrigger asChild>
          <span className="ml-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="shrink-0">{fileName}</span>
            {dir && (
              <span className="text-[11px] text-foreground/30 whitespace-nowrap">{dir}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all">{fullPath}</TooltipContent>
      </Tooltip>
      <span className="ml-1.5 shrink-0 text-[10px] text-foreground/35">
        {language === 'zh' ? '新文件' : 'new file'}
      </span>
    </div>
  )
}
