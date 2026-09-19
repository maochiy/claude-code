import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDiffContents, getFileDiff, getWorktreeChanges } from './git-diff-service'

let repositoryPath = ''

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryPath, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repositoryPath = mkdtempSync(join(tmpdir(), 'proma-worktree-diff-'))
  execFileSync('git', ['init', '-b', 'main', repositoryPath])
  git(['config', 'user.email', 'proma-test@example.com'])
  git(['config', 'user.name', 'Proma Test'])
  writeFileSync(join(repositoryPath, 'base.txt'), 'base\n')
  git(['add', 'base.txt'])
  git(['commit', '-m', 'base'])
  git(['checkout', '-b', 'session-branch'])
  writeFileSync(join(repositoryPath, 'session.txt'), 'session\n')
  git(['add', 'session.txt'])
  git(['commit', '-m', 'session change'])
})

afterEach(() => {
  rmSync(repositoryPath, { recursive: true, force: true })
})

describe('Worktree 改动比较', () => {
  test('Given 旧文件包含缩进和末尾空行 When 追加内容 Then 原有空白保持不变且 patch 与 Git 一致', async () => {
    const original = '  原有缩进\n\n'
    const modified = `${original}新增行\n`
    writeFileSync(join(repositoryPath, 'whitespace.txt'), original)
    git(['add', 'whitespace.txt'])
    git(['commit', '-m', 'preserve whitespace fixture'])
    writeFileSync(join(repositoryPath, 'whitespace.txt'), modified)

    expect(await getDiffContents(repositoryPath, 'whitespace.txt', repositoryPath)).toEqual({
      oldContent: original,
      newContent: modified,
    })
    const expectedPatch = execFileSync('git', ['diff', '--', 'whitespace.txt'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    })
    expect(await getFileDiff(repositoryPath, 'whitespace.txt', repositoryPath)).toBe(expectedPatch)
    expect(expectedPatch).not.toContain('No newline at end of file')
  })

  test('Given 文件原本没有末尾换行 When 读取 Diff Then 不伪造换行', async () => {
    const original = '  无末尾换行  '
    writeFileSync(join(repositoryPath, 'no-newline.txt'), original)
    git(['add', 'no-newline.txt'])
    git(['commit', '-m', 'no newline fixture'])
    expect(await getDiffContents(repositoryPath, 'no-newline.txt', repositoryPath)).toEqual({
      oldContent: original,
      newContent: original,
    })
  })

  test('Given 会话记录了本地基准分支 When 读取完整改动 Then 按该分支比较且不依赖 origin/main', async () => {
    const result = await getWorktreeChanges(repositoryPath, 'main')

    expect(result.isGitRepo).toBe(true)
    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'session.txt', additions: 1, deletions: 0 }),
    ]))
  })
})
