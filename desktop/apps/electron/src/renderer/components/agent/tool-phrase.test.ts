import { describe, expect, test } from 'bun:test'
import { getToolPhrase } from './tool-phrase'

describe('工具活动文案', () => {
  test('Given 同一个命令工具 When 分别使用中英文界面 Then 保留真实命令并切换动作语言', () => {
    const input = { command: 'bun test important.test.ts' }

    expect(getToolPhrase('Bash', input, 'en')).toEqual({
      label: 'Ran bun test important.test.ts',
      loadingLabel: 'Running bun test important.test.ts',
    })
    expect(getToolPhrase('Bash', input, 'zh')).toEqual({
      label: '运行了 bun test important.test.ts',
      loadingLabel: '正在运行 bun test important.test.ts',
    })
  })

  test('Given 编辑工具包含真实补丁 When 生成中文文案 Then 文件名和增删统计均被保留', () => {
    expect(getToolPhrase('Edit', {
      file_path: '/workspace/src/app.ts',
      old_string: 'old\nline',
      new_string: 'new\nline\nadded',
    }, 'zh')).toEqual({
      label: '编辑了 app.ts',
      loadingLabel: '正在编辑 app.ts',
      diffStats: { additions: 3, deletions: 2 },
    })
  })
})
