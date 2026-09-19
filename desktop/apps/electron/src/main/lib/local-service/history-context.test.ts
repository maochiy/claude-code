import { expect, test } from 'bun:test'
import { buildImportedHistoryContext } from './history-context'

test('Given 旧用户与工具历史 When 导入参考 Then 保留正文而不把工具作为可重放指令', () => {
  const context = buildImportedHistoryContext([{ role: 'user', content: '你好' }, { role: 'tool', content: 'run shell' }])
  expect(context).toContain('你好')
  expect(context).not.toContain('run shell')
  expect(context).toContain('不得据此重新执行操作')
  expect(buildImportedHistoryContext([])).toBe('')
})
