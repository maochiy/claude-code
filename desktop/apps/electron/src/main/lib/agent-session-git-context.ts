import { statSync } from 'node:fs'
import type { AgentSessionMeta } from '@proma/shared'

/** 新会话继续只接受同一项目中真实存在的隔离目录，不回退主目录或悄悄重建。 */
export function resolveReusedSessionGitContext(
  source: Pick<AgentSessionMeta, 'workspaceId' | 'gitBaseBranch' | 'worktreePath'> | null | undefined,
  workspaceId: string | undefined,
): Pick<AgentSessionMeta, 'gitBaseBranch' | 'worktreePath'> {
  if (!source || !workspaceId || source.workspaceId !== workspaceId) {
    throw new Error('无法复用隔离目录：源会话不存在或不属于当前项目')
  }
  if (!source.worktreePath || !source.gitBaseBranch) {
    throw new Error('源会话没有可复用的 worktree 配置')
  }
  let isDirectory = false
  try { isDirectory = statSync(source.worktreePath).isDirectory() } catch { /* 下方统一报告目录缺失 */ }
  if (!isDirectory) throw new Error(`会话 worktree 目录不存在：${source.worktreePath}`)
  return { gitBaseBranch: source.gitBaseBranch, worktreePath: source.worktreePath }
}
