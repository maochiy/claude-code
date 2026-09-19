import { describe, expect, test } from 'bun:test'
import { resolveSidePanelStackLayout } from './side-panel-stack-layout'

describe('右侧独立面板纵向布局', () => {
  test('Given 计划与后台任务依次打开 When 解析布局 Then 计划在上且后台任务在下', () => {
    expect(resolveSidePanelStackLayout(['plan', 'tasks'], 'files')).toEqual({
      activeTab: 'plan',
      stackedPrimary: 'plan',
      auxiliaryTab: 'tasks',
    })
  })

  test('Given 仅打开一个独立面板 When 解析布局 Then 它占据主面板且没有辅助面板', () => {
    expect(resolveSidePanelStackLayout(['tasks'], 'files')).toEqual({
      activeTab: 'tasks',
      stackedPrimary: 'tasks',
      auxiliaryTab: undefined,
    })
  })

  test('Given 堆叠状态含重复项 When 解析布局 Then 不重复挂载同一面板', () => {
    expect(resolveSidePanelStackLayout(['plan', 'plan', 'tasks'], 'files')).toEqual({
      activeTab: 'plan',
      stackedPrimary: 'plan',
      auxiliaryTab: 'tasks',
    })
  })

  test('Given 没有独立面板 When 解析布局 Then 保留原有活动 Tab', () => {
    expect(resolveSidePanelStackLayout([], 'terminal:session-1')).toEqual({
      activeTab: 'terminal:session-1',
    })
  })
})
