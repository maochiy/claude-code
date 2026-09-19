import type { AgentSessionGitContext, AgentSessionMeta } from '@proma/shared'

/** 新会话继续时只复用已持久化且信息完整的 worktree，避免猜测路径。 */
export function getReusableAgentSessionGitContext(
  session: AgentSessionMeta | undefined,
): AgentSessionGitContext | undefined {
  if (!session?.worktreePath || !session.gitBaseBranch) return undefined
  return {
    baseBranch: session.gitBaseBranch,
    useWorktree: true,
    reuseWorktreeFromSessionId: session.id,
  }
}
