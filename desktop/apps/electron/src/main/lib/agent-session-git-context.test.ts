import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReusedSessionGitContext } from './agent-session-git-context'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const worktreePath = mkdtempSync(join(tmpdir(), 'proma-reuse-worktree-'))
  roots.push(worktreePath)
  return { workspaceId: 'project-a', gitBaseBranch: 'develop', worktreePath }
}

describe('继续会话复用隔离目录', () => {
  test('Given 同项目存在的源目录 When 继续 Then 原样保留路径和基准分支', () => {
    const source = fixture()
    expect(resolveReusedSessionGitContext(source, 'project-a')).toEqual({ worktreePath: source.worktreePath, gitBaseBranch: 'develop' })
  })
  test('Given 源会话来自其他项目或不存在 When 请求复用 Then 明确拒绝', () => {
    expect(() => resolveReusedSessionGitContext(fixture(), 'project-b')).toThrow('不属于当前项目')
    expect(() => resolveReusedSessionGitContext(null, 'project-a')).toThrow('源会话不存在')
  })
  test('Given worktree缺失或是普通文件 When 请求继续 Then 不回退到主项目', () => {
    const source = fixture()
    expect(() => resolveReusedSessionGitContext({ ...source, worktreePath: join(source.worktreePath, 'missing') }, 'project-a')).toThrow('目录不存在')
    const file = join(source.worktreePath, 'ordinary-file')
    writeFileSync(file, 'fixture')
    expect(() => resolveReusedSessionGitContext({ ...source, worktreePath: file }, 'project-a')).toThrow('目录不存在')
  })
  test('Given 源会话未记录worktree或base branch When 请求复用 Then 明确报告配置缺失', () => {
    const source = fixture()
    expect(() => resolveReusedSessionGitContext({ ...source, gitBaseBranch: undefined }, 'project-a')).toThrow('worktree 配置')
    expect(() => resolveReusedSessionGitContext({ ...source, worktreePath: undefined }, 'project-a')).toThrow('worktree 配置')
  })
})
