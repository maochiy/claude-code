import { describe, expect, test } from 'bun:test'
import {
  filterHomeSlashCommands,
  getHomeSlashQuery,
  resolveHomeCommandCatalogWorkspaceId,
} from './HomeSlashCommandMenu'

describe('主页 slash 命令触发', () => {
  test('Given 新建会话输入 slash token When 解析 Then 打开候选并保留当前查询', () => {
    expect(getHomeSlashQuery('/')).toBe('')
    expect(getHomeSlashQuery('/reV')).toBe('rev')
    expect(getHomeSlashQuery('please /review')).toBeNull()
    expect(getHomeSlashQuery('/review now')).toBeNull()
  })

  test('Given CLI initialize 返回目录 When 输入命令片段 Then 只显示原生匹配项', () => {
    const commands = [
      { name: 'review', description: 'Review changes', argumentHint: '<path>' },
      { name: 'compact', description: 'Compact context', argumentHint: '' },
    ]

    expect(filterHomeSlashCommands(commands, 'rev')).toEqual([commands[0]!])
    expect(filterHomeSlashCommands(commands, 'context')).toEqual([commands[1]!])
    expect(filterHomeSlashCommands(commands, '')).toEqual(commands)
  })

  test('Given 首页尚未恢复显式项目 When 存在默认项目 Then slash 目录使用默认项目且不创建会话', () => {
    expect(resolveHomeCommandCatalogWorkspaceId(null, [{
      id: 'workspace-default',
      name: 'Default',
      slug: 'default',
      path: '/projects/default',
      canonicalPath: '/projects/default',
      createdAt: 1,
      updatedAt: 1,
    }])).toBe('workspace-default')
    expect(resolveHomeCommandCatalogWorkspaceId(null, [])).toBeNull()
  })
})
