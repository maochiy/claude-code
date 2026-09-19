/**
 * useSessionGitSummary — 会话 Git 摘要加载与缓存（共享 Hook）
 *
 * 从 SessionFloatingPanel 抽取的逻辑：加载会话工作目录的 Git 仓库状态
 * 与未暂存变更统计，写入 agentSessionGitSummaryAtom，供 Git Dock 与悬浮面板共用。
 * 挂载、窗口聚焦、diff/工作区文件版本变化时自动刷新。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  agentDiffRefreshVersionAtom,
  agentSessionGitSummaryAtom,
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  workspaceFilesVersionAtom,
  type AgentSessionGitSummary,
} from '@/atoms/agent-atoms'

const EMPTY_PATHS: string[] = []

export function useSessionGitSummary(
  sessionId: string,
  sessionPath: string | null,
): {
  gitSummary: AgentSessionGitSummary | undefined
  /** 分支切换成功后同步缓存中的分支名并触发一次刷新 */
  applyBranchChange: (branch: string) => void
  /** 主动触发一次刷新 */
  refresh: () => void
} {
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const workspaceAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const workspaceAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? EMPTY_PATHS
  const attachedFiles = attachedFilesMap.get(sessionId) ?? EMPTY_PATHS
  const workspaceAttachedDirs = workspaceAttachedDirsMap.get(currentWorkspaceId ?? '') ?? EMPTY_PATHS
  const workspaceAttachedFiles = workspaceAttachedFilesMap.get(currentWorkspaceId ?? '') ?? EMPTY_PATHS
  const diffRefreshVersion = useAtomValue(agentDiffRefreshVersionAtom).get(sessionId) ?? 0
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const setGitSummaryMap = useSetAtom(agentSessionGitSummaryAtom)
  const setDiffRefreshVersion = useSetAtom(agentDiffRefreshVersionAtom)
  const gitSummary = useAtomValue(agentSessionGitSummaryAtom).get(sessionId)

  const refresh = React.useCallback(() => {
    setDiffRefreshVersion((previous) => {
      const next = new Map(previous)
      next.set(sessionId, (previous.get(sessionId) ?? 0) + 1)
      return next
    })
  }, [sessionId, setDiffRefreshVersion])

  const applyBranchChange = React.useCallback((branch: string) => {
    setGitSummaryMap((previous) => {
      const current = previous.get(sessionId)
      if (!current) return previous
      const next = new Map(previous)
      next.set(sessionId, {
        ...current,
        repoStatus: current.repoStatus
          ? { ...current.repoStatus, branch }
          : {
              isRepo: true,
              branch,
              hasChanges: current.filesChanged > 0,
              remoteUrl: null,
            },
        updatedAt: Date.now(),
      })
      return next
    })
    refresh()
  }, [refresh, sessionId, setGitSummaryMap])

  React.useEffect(() => {
    let cancelled = false
    let refreshSequence = 0
    if (!sessionPath) {
      setGitSummaryMap((previous) => {
        if (!previous.has(sessionId)) return previous
        const next = new Map(previous)
        next.delete(sessionId)
        return next
      })
      return
    }

    const refreshGitSummary = async (): Promise<void> => {
      const sequence = ++refreshSequence
      try {
        const workspaceFilesPath = workspaceSlug
          ? await window.electronAPI.getWorkspaceFilesPath(workspaceSlug)
          : null
        const extraPaths = [
          ...attachedDirs,
          ...workspaceAttachedDirs,
          ...attachedFiles,
          ...workspaceAttachedFiles,
        ]
        const [nextRepoStatus, changes] = await Promise.all([
          window.electronAPI.getGitRepoStatus(sessionPath),
          window.electronAPI.getUnstagedChanges(
            sessionPath,
            sessionPath,
            workspaceFilesPath ?? undefined,
            extraPaths,
            sessionId,
          ),
        ])
        if (cancelled || sequence !== refreshSequence) return
        setGitSummaryMap((previous) => {
          const next = new Map(previous)
          next.set(sessionId, {
            repoStatus: nextRepoStatus,
            filesChanged: changes.files.length + changes.untrackedFiles.length,
            additions: changes.files.reduce((sum, file) => sum + file.additions, 0),
            deletions: changes.files.reduce((sum, file) => sum + file.deletions, 0),
            updatedAt: Date.now(),
          })
          return next
        })
      } catch {
        if (cancelled || sequence !== refreshSequence) return
        setGitSummaryMap((previous) => {
          const next = new Map(previous)
          next.set(sessionId, {
            repoStatus: null,
            filesChanged: 0,
            additions: 0,
            deletions: 0,
            updatedAt: Date.now(),
          })
          return next
        })
      }
    }

    void refreshGitSummary()
    const handleWindowFocus = (): void => {
      void refreshGitSummary()
    }
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      cancelled = true
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [
    attachedDirs,
    attachedFiles,
    diffRefreshVersion,
    filesVersion,
    sessionId,
    sessionPath,
    setGitSummaryMap,
    workspaceAttachedDirs,
    workspaceAttachedFiles,
    workspaceSlug,
  ])

  return { gitSummary, applyBranchChange, refresh }
}
