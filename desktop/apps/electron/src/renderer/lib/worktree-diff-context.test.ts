import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { getWorktreeDiffContext } from './worktree-diff-context'

const SESSION: AgentSessionMeta = {
  id: 'session-a',
  title: 'Worktree 会话',
  gitBaseBranch: 'release/1.2',
  worktreePath: '/worktrees/session-a',
  createdAt: 1,
  updatedAt: 1,
}

describe('会话 Worktree Diff 上下文', () => {
  test('Given 会话有托管worktree When 未另选路径 Then 使用会话路径和实际基准分支', () => {
    expect(getWorktreeDiffContext(SESSION, null)).toEqual({
      path: '/worktrees/session-a',
      baseBranch: 'release/1.2',
    })
  })

  test('Given 用户另选worktree When 比较改动 Then 仍使用会话记录的基准而非origin/main', () => {
    expect(getWorktreeDiffContext(SESSION, '/worktrees/other')).toEqual({
      path: '/worktrees/other',
      baseBranch: 'release/1.2',
    })
  })
})
