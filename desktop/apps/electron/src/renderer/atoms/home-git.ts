import { atom } from 'jotai'
import type { AgentSessionGitContext } from '@proma/shared'

export interface HomeGitSelection {
  baseBranch: string
  useWorktree: boolean
}

/** 主页按项目保存的新会话 Git 选择；创建会话前不会修改项目。 */
export const homeGitSelectionByWorkspaceAtom = atom<Map<string, HomeGitSelection>>(new Map())

export function updateHomeGitSelection(
  current: Map<string, HomeGitSelection>,
  workspaceId: string,
  update: Partial<HomeGitSelection>,
  fallbackBranch = '',
): Map<string, HomeGitSelection> {
  const next = new Map(current)
  const previous = next.get(workspaceId) ?? { baseBranch: fallbackBranch, useWorktree: false }
  next.set(workspaceId, { ...previous, ...update })
  return next
}

export function getHomeAgentGitContext(
  current: Map<string, HomeGitSelection>,
  workspaceId: string | null,
): AgentSessionGitContext | undefined {
  if (!workspaceId) return undefined
  const selection = current.get(workspaceId)
  if (!selection?.baseBranch) return undefined
  return { baseBranch: selection.baseBranch, useWorktree: selection.useWorktree }
}

/** 有项目时必须等该项目的 Git 状态完成解析；无项目的 Local 会话可直接创建。 */
export function isHomeGitContextReady(
  workspaceId: string | null,
  readyWorkspaceId: string | null,
): boolean {
  return !workspaceId || workspaceId === readyWorkspaceId
}
