import { describe, expect, test } from 'bun:test'
import { getHomeAgentGitContext, isHomeGitContextReady, updateHomeGitSelection } from './home-git'

describe('主页 Git 选择', () => {
  test('Given 新项目 When 首次记录分支 Then worktree 默认不勾选', () => {
    const next = updateHomeGitSelection(new Map(), 'project-a', { baseBranch: 'main' }, 'main')
    expect(next.get('project-a')).toEqual({ baseBranch: 'main', useWorktree: false })
  })

  test('Given 已选择分支 When 勾选 worktree Then 保留分支并更新勾选状态', () => {
    const current = new Map([['project-a', { baseBranch: 'feature', useWorktree: false }]])
    const next = updateHomeGitSelection(current, 'project-a', { useWorktree: true })
    expect(next.get('project-a')).toEqual({ baseBranch: 'feature', useWorktree: true })
    expect(current.get('project-a')?.useWorktree).toBe(false)
  })

  test('Given 分支和 worktree 已选择 When 创建 Code 会话 Then 生成真实创建参数', () => {
    const current = new Map([['project-a', { baseBranch: 'feature', useWorktree: true }]])
    expect(getHomeAgentGitContext(current, 'project-a')).toEqual({
      baseBranch: 'feature',
      useWorktree: true,
    })
  })

  test('Given 项目 Git 状态尚未返回 When 用户尝试发送 Then 不允许静默创建到其它目录', () => {
    expect(isHomeGitContextReady('project-a', null)).toBe(false)
    expect(isHomeGitContextReady('project-a', 'project-b')).toBe(false)
    expect(isHomeGitContextReady('project-a', 'project-a')).toBe(true)
    expect(isHomeGitContextReady(null, null)).toBe(true)
  })
})
