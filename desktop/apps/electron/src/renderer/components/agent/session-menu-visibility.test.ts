import { describe, expect, test } from 'bun:test'
import {
  shouldShowBackgroundTasksEntry,
  shouldShowPlanEntry,
} from './session-menu-visibility'

describe('会话菜单数据入口', () => {
  test('Given 当前会话没有计划文档和可见 Todo When 生成菜单 Then 隐藏计划入口', () => {
    expect(shouldShowPlanEntry({ hasPlanDocument: false, visibleTodoCount: 0 })).toBe(false)
  })

  test('Given 当前会话有计划文档或可见 Todo When 生成菜单 Then 显示计划入口', () => {
    expect(shouldShowPlanEntry({ hasPlanDocument: true, visibleTodoCount: 0 })).toBe(true)
    expect(shouldShowPlanEntry({ hasPlanDocument: false, visibleTodoCount: 2 })).toBe(true)
  })

  test('Given 当前会话没有后台任务 When 生成菜单 Then 隐藏后台任务入口', () => {
    expect(shouldShowBackgroundTasksEntry(0)).toBe(false)
    expect(shouldShowBackgroundTasksEntry(1)).toBe(true)
  })
})
