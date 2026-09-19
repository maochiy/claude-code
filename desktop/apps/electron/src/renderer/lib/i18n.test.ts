import { describe, expect, test } from 'bun:test'
import { translate } from './i18n'

describe('界面翻译', () => {
  test('同一词条根据语言返回对应文案', () => {
    expect(translate('zh', 'sidebar.customize')).toBe('自定义')
    expect(translate('en', 'sidebar.customize')).toBe('Customize')
  })

  test('替换动态参数并保留缺失参数占位符', () => {
    expect(translate('en', 'home.greeting', { name: 'Ming' })).toBe("What's up next, Ming?")
    expect(translate('zh', 'sidePanel.closeTab')).toBe('关闭{name}')
  })

  test('slash 命令菜单标题与命令描述跟随界面语言', () => {
    expect(translate('zh', 'slash.header')).toBe('命令和 Skills')
    expect(translate('zh', 'slash.modelDescription')).toBe('打开模型选择')
    expect(translate('en', 'slash.header')).toBe('Commands and Skills')
    expect(translate('en', 'slash.modelDescription')).toBe('Open model selection')
  })

  test('Given 删除后保留了 worktree When 界面语言切换 Then 警告文案与数量使用当前语言', () => {
    expect(translate('zh', 'agent.worktreesRetained', { count: 2 })).toBe('已保留 2 个 Worktree，请手动处理')
    expect(translate('en', 'agent.worktreesRetained', { count: 2 })).toBe('2 worktrees were kept and need manual cleanup')
  })

  test('Given OpenSwitch 是可选渠道 When 切换界面语言 Then 登录入口不会描述成桌面门禁', () => {
    expect(translate('zh', 'openSwitch.skip')).toBe('暂不登录')
    expect(translate('en', 'openSwitch.accountDescription')).toContain('Optionally connect')
    expect(translate('en', 'openSwitch.optionalDescription')).toContain('without signing in')
  })
})
