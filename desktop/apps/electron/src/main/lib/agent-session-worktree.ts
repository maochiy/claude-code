/**
 * 新会话 Git 工作目录准备。
 *
 * 分支选择只在提交创建会话时生效：普通模式检出项目分支，worktree 模式从
 * 选中分支创建带命名分支的 worktree，避免首页浏览分支时修改用户仓库，
 * 同时保证会话提交在移除 worktree 后仍有分支引用。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { getConfigDir } from './config-paths'
import type { AgentSessionMeta, RetainedAgentWorktree } from '@proma/shared'

interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface PrepareAgentSessionGitInput {
  sessionId: string
  workspacePath: string
  baseBranch: string
  useWorktree: boolean
  worktreeLocation: 'inside-project' | 'global'
}

export interface PreparedAgentSessionGit {
  gitBaseBranch: string
  worktreePath?: string
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => resolveResult({ code: null, stdout, stderr: error.message }))
    child.on('close', (code) => resolveResult({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

function gitError(result: GitResult, fallback: string): Error {
  const message = (result.stderr || result.stdout || fallback).split(/\r?\n/).find(Boolean) ?? fallback
  return new Error(message)
}

async function resolveRepositoryRoot(workspacePath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], workspacePath)
  if (result.code !== 0 || !result.stdout) throw gitError(result, '当前项目不是 Git 仓库')
  return resolve(result.stdout)
}

async function validateLocalBranch(repoRoot: string, branch: string): Promise<string> {
  const normalized = branch.trim()
  if (!normalized || normalized.startsWith('-')) throw new Error('无效的 Git 分支')
  const format = await runGit(['check-ref-format', '--branch', normalized], repoRoot)
  if (format.code !== 0) throw gitError(format, '无效的 Git 分支')
  const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${normalized}`], repoRoot)
  if (exists.code !== 0) throw new Error(`本地分支不存在：${normalized}`)
  return normalized
}

async function resolveGitCommonDirectory(repoRoot: string): Promise<string> {
  const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot)
  if (result.code !== 0 || !result.stdout) throw gitError(result, '无法读取 Git 元数据目录')
  return isAbsolute(result.stdout) ? result.stdout : resolve(repoRoot, result.stdout)
}

async function resolveWorktreePath(input: PrepareAgentSessionGitInput, repoRoot: string): Promise<string> {
  if (input.worktreeLocation === 'inside-project') {
    const gitCommonDirectory = await resolveGitCommonDirectory(repoRoot)
    return join(gitCommonDirectory, 'proma-worktrees', input.sessionId)
  }
  return join(getConfigDir(), 'worktrees', basename(repoRoot), input.sessionId)
}

export async function prepareAgentSessionGit(
  input: PrepareAgentSessionGitInput,
): Promise<PreparedAgentSessionGit> {
  const repoRoot = await resolveRepositoryRoot(input.workspacePath)
  const baseBranch = await validateLocalBranch(repoRoot, input.baseBranch)

  if (!input.useWorktree) {
    const checkout = await runGit(['checkout', baseBranch], repoRoot)
    if (checkout.code !== 0) throw gitError(checkout, `无法检出分支：${baseBranch}`)
    return { gitBaseBranch: baseBranch }
  }

  const worktreePath = await resolveWorktreePath(input, repoRoot)
  if (existsSync(worktreePath)) throw new Error(`Worktree 目录已存在：${worktreePath}`)
  mkdirSync(dirname(worktreePath), { recursive: true })
  const sessionBranch = `codex/${input.sessionId}`
  const add = await runGit(['worktree', 'add', '-b', sessionBranch, worktreePath, baseBranch], repoRoot)
  if (add.code !== 0) {
    rmSync(worktreePath, { recursive: true, force: true })
    throw gitError(add, '创建 worktree 失败')
  }
  return { gitBaseBranch: baseBranch, worktreePath }
}

/** 文件面板、终端和 Runtime 共用同一会话工作路径解析规则。 */
export function resolveAgentSessionWorkingDirectory(
  session: Pick<AgentSessionMeta, 'worktreePath'> | undefined,
  workspacePath: string,
): string {
  if (session?.worktreePath) {
    if (!existsSync(session.worktreePath)) {
      throw new Error(`会话 Worktree 不存在：${session.worktreePath}`)
    }
    return session.worktreePath
  }
  if (!existsSync(workspacePath)) throw new Error(`项目目录不可用，请重新添加项目：${workspacePath}`)
  return workspacePath
}

/** 删除会话时清理由 Proma 托管的 worktree。 */
export function removeManagedAgentSessionWorktree(
  workspacePath: string | undefined,
  worktreePath: string | undefined,
): RetainedAgentWorktree | undefined {
  if (!worktreePath || !existsSync(worktreePath)) return undefined
  if (!workspacePath) {
    console.warn(`[Agent 会话] 缺少项目目录，Worktree 已保留: ${worktreePath}`)
    return { path: worktreePath, reason: 'cleanup_failed' }
  }
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  })
  if (status.status !== 0) {
    console.warn(`[Agent 会话] 无法检查 Worktree 状态，已保留: ${status.stderr || worktreePath}`)
    return { path: worktreePath, reason: 'cleanup_failed' }
  }
  if (status.stdout.trim()) {
    console.warn(`[Agent 会话] Worktree 含未提交改动，已保留: ${worktreePath}`)
    return { path: worktreePath, reason: 'dirty' }
  }
  const result = spawnSync('git', ['worktree', 'remove', worktreePath], {
    cwd: workspacePath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  })
  if (result.status !== 0 && existsSync(worktreePath)) {
    console.warn(`[Agent 会话] Git worktree 清理失败，已保留: ${result.stderr || worktreePath}`)
    return { path: worktreePath, reason: 'cleanup_failed' }
  }
  console.log(`[Agent 会话] 已清理 Git worktree: ${worktreePath}`)
  return undefined
}
