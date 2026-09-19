import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { prepareAgentSessionGit, removeManagedAgentSessionWorktree, resolveAgentSessionWorkingDirectory } from './agent-session-worktree'

let fixtureRoot = ''
let repositoryPath = ''
let originalBranch = ''

function git(args: string[], cwd = repositoryPath): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-session-worktree-'))
  repositoryPath = join(fixtureRoot, 'repository')
  execFileSync('git', ['init', '-b', 'main', repositoryPath])
  git(['config', 'user.email', 'proma-test@example.com'])
  git(['config', 'user.name', 'Proma Test'])
  writeFileSync(join(repositoryPath, 'base.txt'), 'main')
  git(['add', 'base.txt'])
  git(['commit', '-m', 'main'])
  originalBranch = git(['branch', '--show-current'])
  git(['checkout', '-b', 'feature'])
  writeFileSync(join(repositoryPath, 'feature.txt'), 'feature')
  git(['add', 'feature.txt'])
  git(['commit', '-m', 'feature'])
  git(['checkout', originalBranch])
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('新会话 Git 工作目录', () => {
  test('Given 选中 feature 并勾选 worktree When 准备会话 Then 原项目分支不变且会话拥有独立命名分支', async () => {
    const result = await prepareAgentSessionGit({
      sessionId: 'session-worktree',
      workspacePath: repositoryPath,
      baseBranch: 'feature',
      useWorktree: true,
      worktreeLocation: 'inside-project',
    })

    expect(result.gitBaseBranch).toBe('feature')
    expect(result.worktreePath).toBeDefined()
    expect(git(['branch', '--show-current'])).toBe(originalBranch)
    expect(readFileSync(join(result.worktreePath!, 'feature.txt'), 'utf8')).toBe('feature')
    expect(git(['branch', '--show-current'], result.worktreePath)).toBe('codex/session-worktree')

    const cleanup = removeManagedAgentSessionWorktree(repositoryPath, result.worktreePath)
    expect(cleanup).toBeUndefined()
    expect(existsSync(result.worktreePath!)).toBe(false)
    expect(git(['show-ref', '--verify', '--quiet', 'refs/heads/codex/session-worktree'])).toBe('')
  })

  test('Given 选中 feature 并取消 worktree When 准备会话 Then 使用原项目并在提交时检出所选分支', async () => {
    const result = await prepareAgentSessionGit({
      sessionId: 'session-local',
      workspacePath: repositoryPath,
      baseBranch: 'feature',
      useWorktree: false,
      worktreeLocation: 'inside-project',
    })

    expect(result).toEqual({ gitBaseBranch: 'feature' })
    expect(git(['branch', '--show-current'])).toBe('feature')
  })

  test('Given 原项目存在会被覆盖的未跟踪文件 When 取消 worktree 后检出其他分支 Then 创建失败且用户改动原样保留', async () => {
    writeFileSync(join(repositoryPath, 'feature.txt'), 'local change')

    await expect(prepareAgentSessionGit({
      sessionId: 'session-conflict',
      workspacePath: repositoryPath,
      baseBranch: 'feature',
      useWorktree: false,
      worktreeLocation: 'inside-project',
    })).rejects.toThrow()

    expect(git(['branch', '--show-current'])).toBe(originalBranch)
    expect(readFileSync(join(repositoryPath, 'feature.txt'), 'utf8')).toBe('local change')
  })

  test('Given worktree 有未提交改动 When 删除会话清理工作目录 Then 保留 worktree 和用户改动', async () => {
    const result = await prepareAgentSessionGit({
      sessionId: 'session-dirty',
      workspacePath: repositoryPath,
      baseBranch: 'feature',
      useWorktree: true,
      worktreeLocation: 'inside-project',
    })
    writeFileSync(join(result.worktreePath!, 'feature.txt'), 'dirty change')

    const cleanup = removeManagedAgentSessionWorktree(repositoryPath, result.worktreePath)

    expect(cleanup).toEqual({ path: result.worktreePath!, reason: 'dirty' })
    expect(existsSync(result.worktreePath!)).toBe(true)
    expect(readFileSync(join(result.worktreePath!, 'feature.txt'), 'utf8')).toBe('dirty change')
  })

  test('Given worktree 存在但项目目录缺失 When 删除会话 Then 返回可展示的清理失败路径', async () => {
    const result = await prepareAgentSessionGit({
      sessionId: 'session-missing-workspace',
      workspacePath: repositoryPath,
      baseBranch: 'feature',
      useWorktree: true,
      worktreeLocation: 'inside-project',
    })

    const cleanup = removeManagedAgentSessionWorktree(undefined, result.worktreePath)

    expect(cleanup).toEqual({ path: result.worktreePath!, reason: 'cleanup_failed' })
    expect(existsSync(result.worktreePath!)).toBe(true)
  })

  test('Given 分支不存在 When 准备 worktree Then 明确失败且不创建工作目录', async () => {
    await expect(prepareAgentSessionGit({
      sessionId: 'session-missing',
      workspacePath: repositoryPath,
      baseBranch: 'missing-branch',
      useWorktree: true,
      worktreeLocation: 'inside-project',
    })).rejects.toThrow('本地分支不存在：missing-branch')

    expect(existsSync(join(repositoryPath, '.git', 'proma-worktrees', 'session-missing'))).toBe(false)
  })

  test('Given 会话记录的 worktree 已丢失 When 文件面板或 Runtime 解析路径 Then 不回退到原项目', () => {
    const missingPath = join(fixtureRoot, 'missing-worktree')
    expect(() => resolveAgentSessionWorkingDirectory(
      { worktreePath: missingPath },
      repositoryPath,
    )).toThrow(`会话 Worktree 不存在：${missingPath}`)
  })
})
