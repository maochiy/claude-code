import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { getReusableAgentSessionGitContext } from './agent-session-git-context'

function session(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'source-session',
    title: '源会话',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('继续会话 Git 上下文', () => {
  test('Given 源会话使用托管 worktree When 在新会话继续 Then 明确复用同一目录来源', () => {
    expect(getReusableAgentSessionGitContext(session({
      gitBaseBranch: 'main',
      worktreePath: '/tmp/proma-worktree',
    }))).toEqual({
      baseBranch: 'main',
      useWorktree: true,
      reuseWorktreeFromSessionId: 'source-session',
    })
  })

  test('Given 源会话不是worktree或元数据不完整 When 在新会话继续 Then 不猜测复用路径', () => {
    expect(getReusableAgentSessionGitContext(session({ gitBaseBranch: 'main' }))).toBeUndefined()
    expect(getReusableAgentSessionGitContext(session({ worktreePath: '/tmp/proma-worktree' }))).toBeUndefined()
  })
})
