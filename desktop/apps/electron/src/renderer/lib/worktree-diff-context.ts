import type { AgentSessionMeta } from '@proma/shared'

export interface WorktreeDiffContext {
  path: string
  baseBranch: string
}

/** 当前会话的托管 worktree 优先作为改动源，用户可临时选择同项目的其它 worktree。 */
export function getWorktreeDiffContext(
  session: AgentSessionMeta | undefined,
  selectedPath: string | null,
): WorktreeDiffContext | undefined {
  const path = selectedPath || session?.worktreePath
  if (!path) return undefined
  return {
    path,
    baseBranch: session?.gitBaseBranch?.trim() || 'HEAD',
  }
}
